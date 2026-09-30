import app from '../src/server-core.js';
import seoRouter from '../src/seo.js';

app.use('/api/seo', seoRouter);

export default app;
