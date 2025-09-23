import cluster from 'node:cluster'
import os from 'node:os'
import process from 'node:process'

if (cluster.isPrimary) {
  const concurrency = process.env.WEB_CONCURRENCY 
    ? parseInt(process.env.WEB_CONCURRENCY)
    : process.env.NODE_ENV === 'production' 
      ? os.availableParallelism()
      : 1
  
  for (let i = 0; i < concurrency; i++)
    cluster.fork()
} else {
  const { startServer } = await import('.')
  await startServer()
  console.log(`Worker ${process.pid} started`)
}