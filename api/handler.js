import { app } from '../backend/server.js';

export default function handler(request, response) {
  const requestUrl = new URL(request.url, 'http://localhost');
  const routePath = requestUrl.searchParams.get('__api_path');
  const segments = routePath?.split('/');
  if (!segments?.length || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    response.statusCode = 400;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'The API route is invalid.' }));
    return;
  }

  requestUrl.searchParams.delete('__api_path');
  request.url = `/api/${segments.map(encodeURIComponent).join('/')}${requestUrl.search}`;
  return app(request, response);
}
