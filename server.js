import process from 'node:process';
import { build } from 'vite';

await build();

const { app } = await import('./backend/server.js');
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`ResumeOut.com frontend and API listening on port ${port}`);
});

server.on('error', error => {
  console.error('Could not start ResumeOut.com frontend and API server.', error);
  process.exitCode = 1;
});
