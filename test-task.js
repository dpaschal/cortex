#!/usr/bin/env node
// Quick test script to submit a task to the cluster

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

// Connect to current leader
const leaderAddress = process.env.LEADER || '100.103.240.34:50051'; // htnas02
console.log(`Connecting to ${leaderAddress}\n`);

const client = new proto.ClusterService(
  leaderAddress,
  grpc.credentials.createInsecure()
);

const taskId = `test-${Date.now()}`;
const targetNode = process.argv[2] || 'rog2-8e800054';
const command = process.argv[3] || 'hostname && date && uname -a';

console.log(`Submitting task ${taskId} to ${targetNode}`);
console.log(`Command: ${command}\n`);

client.SubmitTask({
  spec: {
    taskId: taskId,
    type: 'TASK_TYPE_SHELL',
    submitterNode: 'test-client',
    submitterSession: 'test-session',
    shell: {
      command: command,
      workingDirectory: '/tmp',
      sandboxed: false,
    },
    targetNodes: [targetNode],
    priority: 5,
  },
}, (err, response) => {
  if (err) {
    console.error('Error submitting task:', err.message);
    process.exit(1);
  }

  console.log('Task submitted:');
  console.log('  Task ID:', response.taskId);
  console.log('  Accepted:', response.accepted);
  console.log('  Assigned Node:', response.assignedNode || 'pending');
  console.log('  Rejection Reason:', response.rejectionReason || 'none');

  if (response.accepted) {
    console.log('\nWaiting 3s for task to complete...\n');

    setTimeout(() => {
      client.GetTaskStatus({ taskId: taskId }, (err, status) => {
        if (err) {
          console.error('Error getting status:', err.message);
          process.exit(1);
        }

        console.log('Task Status:');
        console.log('  State:', status.state);
        console.log('  Assigned Node:', status.assignedNode);
        console.log('  Exit Code:', status.exitCode);
        console.log('  Error:', status.error || 'none');

        process.exit(0);
      });
    }, 3000);
  } else {
    process.exit(1);
  }
});
