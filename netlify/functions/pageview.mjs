import { getStore } from '@netlify/blobs';
import { createPageviewHandler } from '../lib/pageview-core.mjs';

const store = getStore({ name: 'biohazard-website-analytics', consistency: 'strong' });
const handler = createPageviewHandler({ store });

export default request => handler(request);
