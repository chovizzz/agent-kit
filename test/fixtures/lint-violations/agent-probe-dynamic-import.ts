export const l = async () =>
  (await import('../../../src/io/agent-probe.js')).runAgentVersionCommand;
