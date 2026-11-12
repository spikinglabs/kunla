// KD-87: Claude's connector directory needs a title and a read-only/destructive hint on every tool.
import { describe, it, expect } from 'vitest';
import * as mcp from '../src/mcp';

describe('tool titles', () => {
  it('every tool has a title', () => {
    const tools: { name: string }[] = (mcp as any).TOOLS;
    expect(tools?.length).toBeGreaterThan(10);
    expect(tools.filter((t) => !mcp.TITLES[t.name]).map((t) => t.name)).toEqual([]);
  });
});
