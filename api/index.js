import app from '../src/server.js';
import seoRouter from '../src/seo.js';

app.use('/api/seo', seoRouter);

export default app;
