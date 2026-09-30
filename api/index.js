import app from '../src/server-core.js';
import { registerMcpRoutes } from '../src/mcp.js';
import seoRouter from '../src/seo.js';

app.use('/api/seo', seoRouter);
registerMcpRoutes(app);

export default app;
