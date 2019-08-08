'use strict';

const _ = require('lodash')
const AWS = require('aws-sdk');
const ec2 = new AWS.EC2();
const ecs = new AWS.ECS();
const route53 = new AWS.Route53();

/**
 * Upsert a public ip DNS record for the incoming task.
 *
 * @param event contains the task in the 'detail' propery
 */
exports.handler = async (event, context, callback) => {
    console.log('Received event: %j', event);

    const task = event.detail;
    const clusterArn = task.clusterArn;
    const taskArn = task.taskArn;
    console.log(`clusterArn: ${clusterArn}, taskArn : ${taskArn}`)

    const clusterName = clusterArn.split(':cluster/')[1];

    const tags = await fetchTags(taskArn)
    const domain = tags['domain']
    const hostedZoneId = tags['hostedZoneId']

    console.log(`cluster: ${clusterName}, domain: ${domain}, hostedZone: ${hostedZoneId}`)

    if (!domain || !hostedZoneId) {
        console.log(`Skipping. Reason: no "domain" and/or "hostedZoneId" tags found for cluster ${clusterArn}`);
        return;
    }

    // for Fargate tasks
    const eniId = getEniId(task);
    const containerInstanceArn = task['containerInstanceArn'];
    if (eniId) {
        console.log(`Fetched eniId ${eniId}`);
        var taskPublicIp = await fetchEniPublicIp(eniId);
        console.log(`Fetched taskPublicIp ${taskPublicIp}`);
    }
    else if (containerInstanceArn) {
        //EC2-type task
        console.log(`Fetched containerInstanceArn ${containerInstanceArn}`);
        var taskPublicIp = await fetchContainerPublicIp({
            "containerInstances":[containerInstanceArn],
            "cluster":clusterArn
        });
        console.log(`Fetched taskPublicIp ${taskPublicIp}`);
    } 
    else {
        console.log("Could not fetch public IP for this task");
        return;

    }   
    const serviceName = task.group.split(":")[1]
    console.log(`task:${serviceName} public-id: ${taskPublicIp}`)

    
    const recordSet = createRecordSet(domain, taskPublicIp)

    await updateDnsRecord(clusterName, hostedZoneId, recordSet)
    console.log(`DNS record update finished for ${domain} (${taskPublicIp})`)
};

async function fetchTags(arn) {
    const response = await ecs.listTagsForResource({
        resourceArn: arn
    }).promise()
    return _.reduce(response.tags, function(hash, tag) {
        var key = tag['key'];
        hash[key] = tag['value'];
        return hash;
      }, {});
}

function getEniId(task) {
    return _.chain(task.attachments)
    .filter(function(attachment) {
        return attachment.type === 'eni'
    })
    .map(function(eniAttachment) {
        return _.chain(eniAttachment.details)
        .filter(function(details) {
            return details.name === 'networkInterfaceId'
        })
        .map(function(details) {
            return details.value
        })
        .head()
        .value()
    })
    .head()
    .value()
}

async function fetchEC2PublicIp(instance) {  
    const params = {
        "InstanceIds":[instance]
    };
    const data = await ec2.describeInstances(params).promise();
    if (!data) {
        console.log("Error describing Instance");
        return ;
    } 
    console.log('Received data from describe Instances: %j', data);
    const publicIp = data.Reservations[0].Instances[0].PublicIpAddress
    console.log('Got Public Ip Address %s', publicIp);
    return publicIp;
}

async function fetchEniPublicIp(eniId) {
    const data = await ec2.describeNetworkInterfaces({
        "NetworkInterfaceIds": [
            eniId
        ]
    }).promise();
    return data.NetworkInterfaces[0].PrivateIpAddresses[0].Association.PublicIp;
}

async function fetchContainerPublicIp(params){
    // var params = {
    //     containerInstances:[instance],
    //     cluster:cluster
    // };

    const data = await ecs.describeContainerInstances(params).promise();
    if (!data) {
        console.log(`Could not get information on Container Instance for cluster ${cluster} and container Instance ${instance}`);
        return;
    }
    const ec2Id = data.containerInstances[0].ec2InstanceId;
    console.log(`Fetched ec2InstanceId ${ec2Id}`);
    if (!ec2Id) {
        console.log(`Could not determine ecInstanceId for container instance ${instance} in cluster ${cluster}`)
        return;
    }
    const publicIp = await fetchEC2PublicIp(ec2Id);
    if (!publicIp) {
        console.log(`Could not fetch public IP for instance ${ec2Id}`)
        return;
    }
    return publicIp;


}

function createRecordSet(domain, publicIp) {
    return {
        "Action": "UPSERT",
        "ResourceRecordSet": {
            "Name": domain,
            "Type": "A",
            "TTL": 180,
            "ResourceRecords": [
                {
                    "Value": publicIp
                }
            ]
        }
    }
}

async function updateDnsRecord(clusterName, hostedZoneId, changeRecordSet) {
    let param = {
        ChangeBatch: {
            "Comment": `Auto generated Record for ECS cluster ${clusterName}`,
            "Changes": [changeRecordSet]
        },
        HostedZoneId: hostedZoneId
    };
    const updateResult = await route53.changeResourceRecordSets(param).promise();
    console.log('updateResult: %j', updateResult);
}
