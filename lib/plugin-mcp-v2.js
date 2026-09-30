import { registerVaelonsReadTools } from './plugin-mcp-read-tools.js';
import { registerVaelonsWriteTools } from './plugin-mcp-write-tools.js';

export function registerVaelonsMcpToolsV2(server, context) {
  server.__vaelonsContext = context;
  registerVaelonsReadTools(server, context);
  registerVaelonsWriteTools(server, context);
}
