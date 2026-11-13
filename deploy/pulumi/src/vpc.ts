/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as cloudflare from '@pulumi/cloudflare'
import * as pulumi from '@pulumi/pulumi'
import { albIngress } from './alb-ingress'

export const createVpc = (
  name: string,
  behindCloudflare = false,
): {
  vpc: aws.ec2.Vpc
  publicSubnets: aws.ec2.Subnet[]
  privateSubnets: aws.ec2.Subnet[]
  albSg: aws.ec2.SecurityGroup
  servicesSg: aws.ec2.SecurityGroup
} => {
  const vpc = new aws.ec2.Vpc(`${name}-vpc`, {
    cidrBlock: '10.0.0.0/16',
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { Name: `${name}-vpc` },
  })

  const igw = new aws.ec2.InternetGateway(`${name}-igw`, {
    vpcId: vpc.id,
    tags: { Name: `${name}-igw` },
  })

  const azs = ['a', 'b']

  const publicSubnets = azs.map(
    (az, i) =>
      new aws.ec2.Subnet(`${name}-public-${az}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i}.0/24`,
        availabilityZone: pulumi.interpolate`${aws.getRegionOutput().region}${az}`,
        mapPublicIpOnLaunch: true,
        tags: { Name: `${name}-public-${az}` },
      }),
  )

  const privateSubnets = azs.map(
    (az, i) =>
      new aws.ec2.Subnet(`${name}-private-${az}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 10}.0/24`,
        availabilityZone: pulumi.interpolate`${aws.getRegionOutput().region}${az}`,
        tags: { Name: `${name}-private-${az}` },
      }),
  )

  // Public route table
  const publicRt = new aws.ec2.RouteTable(`${name}-public-rt`, {
    vpcId: vpc.id,
    routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: igw.id }],
    tags: { Name: `${name}-public-rt` },
  })

  publicSubnets.forEach(
    (subnet, i) =>
      new aws.ec2.RouteTableAssociation(`${name}-public-rta-${i}`, {
        subnetId: subnet.id,
        routeTableId: publicRt.id,
      }),
  )

  // NAT Gateway for private subnets
  const eip = new aws.ec2.Eip(`${name}-nat-eip`, { domain: 'vpc' })
  const natGw = new aws.ec2.NatGateway(`${name}-nat`, {
    subnetId: publicSubnets[0].id,
    allocationId: eip.id,
    tags: { Name: `${name}-nat` },
  })

  const privateRt = new aws.ec2.RouteTable(`${name}-private-rt`, {
    vpcId: vpc.id,
    routes: [{ cidrBlock: '0.0.0.0/0', natGatewayId: natGw.id }],
    tags: { Name: `${name}-private-rt` },
  })

  privateSubnets.forEach(
    (subnet, i) =>
      new aws.ec2.RouteTableAssociation(`${name}-private-rta-${i}`, {
        subnetId: subnet.id,
        routeTableId: privateRt.id,
      }),
  )

  // Security groups
  const albSg = new aws.ec2.SecurityGroup(`${name}-alb-sg`, {
    vpcId: vpc.id,
    // The ALB is IPv4-only. Refresh ranges on every Pulumi run; a failed lookup aborts the deploy.
    ingress: behindCloudflare
      ? cloudflare.getIpRangesOutput({}).apply(({ ipv4Cidrs }) => albIngress(true, ipv4Cidrs))
      : albIngress(false, []),
    egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
    tags: { Name: `${name}-alb-sg` },
  })

  const servicesSg = new aws.ec2.SecurityGroup(`${name}-services-sg`, {
    vpcId: vpc.id,
    ingress: [
      { protocol: '-1', fromPort: 0, toPort: 0, self: true },
      { protocol: 'tcp', fromPort: 0, toPort: 65535, securityGroups: [albSg.id] },
    ],
    egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
    tags: { Name: `${name}-services-sg` },
  })

  return { vpc, publicSubnets, privateSubnets, albSg, servicesSg }
}
