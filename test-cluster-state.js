#!/usr/bin/env node
// Test cluster state

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, 'proto/cluster.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDefinition).claudecluster;

const address = process.argv[2] || '100.103.240.34:50051';
console.log(`Connecting to ${address}\n`);

const client = new proto.ClusterService(
  address,
  grpc.credentials.createInsecure()
);

client.GetClusterState({}, (err, response) => {
  if (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }

  console.log('Cluster State:');
  console.log('  Cluster ID:', response.cluster_id);
  console.log('  Leader ID:', response.leader_id);
  console.log('  Term:', response.term);
  console.log('  Active Tasks:', response.active_tasks);
  console.log('  Queued Tasks:', response.queued_tasks);
  console.log('\nNodes:');

  for (const node of response.nodes || []) {
    console.log(`  - ${node.node_id} (${node.hostname}): ${node.status} [${node.role}]`);
  }
});
