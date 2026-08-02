/**
 * git-diff-adapter.test.ts — Git Diff Adapter 测试 (P2-T4)
 * ===========================================================
 * 覆盖 20 个场景。全部使用 fake runner，不调用真实 git。
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeGitDiffPath,
  parseGitNameOnlyOutput,
  getChangedPathsFromGitDiff,
} from '../../src/project-brain';
import type {
  GitCommandRunner,
  GitCommandResult,
} from '../../src/project-brain';

// ============================================================================
// Fake runner helpers
// ============================================================================

/** 创建一个返回固定输出的 fake runner */
function fakeRunner(stdout = '', stderr = ''): {
  runner: GitCommandRunner;
  calls: Array<{ args: string[]; options: { cwd?: string } }>;
} {
  const calls: Array<{ args: string[]; options: { cwd?: string } }> = [];
  const runner: GitCommandRunner = async (args, options) => {
    calls.push({ args: [...args], options: { ...options } });
    return { stdout, stderr };
  };
  return { runner, calls };
}

function failingRunner(message = 'git: command not found'): GitCommandRunner {
  return async () => {
    throw new Error(message);
  };
}

// ============================================================================
// normalizeGitDiffPath
// ============================================================================

describe('normalizeGitDiffPath', () => {
  it('1. converts backslashes to forward slashes', () => {
    expect(normalizeGitDiffPath('src\\project-brain\\types.ts')).toBe('src/project-brain/types.ts');
  });

  it('2. trims whitespace', () => {
    expect(normalizeGitDiffPath('  src/file.ts  ')).toBe('src/file.ts');
  });

  it('3. strips leading ./', () => {
    expect(normalizeGitDiffPath('./src/file.ts')).toBe('src/file.ts');
  });
});

// ============================================================================
// parseGitNameOnlyOutput
// ============================================================================

describe('parseGitNameOnlyOutput', () => {
  it('4. parses multiple lines', () => {
    const result = parseGitNameOnlyOutput('src/a.ts\nsrc/b.ts\nsrc/c.ts');
    expect(result).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('5. removes empty lines', () => {
    const result = parseGitNameOnlyOutput('src/a.ts\n\n  \nsrc/b.ts');
    expect(result).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('6. deduplicates preserving first occurrence order', () => {
    const result = parseGitNameOnlyOutput('src/b.ts\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/a.ts');
    expect(result).toEqual(['src/b.ts', 'src/a.ts', 'src/c.ts']);
  });
});

// ============================================================================
// getChangedPathsFromGitDiff — command construction
// ============================================================================

describe('getChangedPathsFromGitDiff — command construction', () => {
  it('7. default options → git diff --name-only', async () => {
    const { runner, calls } = fakeRunner('src/new.ts');
    const result = await getChangedPathsFromGitDiff({ runner });
    expect(result).toEqual(['src/new.ts']);
    expect(calls[0].args).toEqual(['diff', '--name-only']);
  });

  it('8. staged → git diff --cached --name-only', async () => {
    const { runner, calls } = fakeRunner('src/staged.ts');
    const result = await getChangedPathsFromGitDiff({ staged: true, runner });
    expect(result).toEqual(['src/staged.ts']);
    expect(calls[0].args).toEqual(['diff', '--cached', '--name-only']);
  });

  it('9. ref diff → git diff --name-only base head', async () => {
    const { runner, calls } = fakeRunner('');
    await getChangedPathsFromGitDiff({
      baseRef: 'main',
      headRef: 'HEAD',
      runner,
    });
    expect(calls[0].args).toEqual(['diff', 'main', 'HEAD', '--name-only']);
  });

  it('10. baseRef only → throws', async () => {
    await expect(
      getChangedPathsFromGitDiff({ baseRef: 'main', runner: fakeRunner().runner }),
    ).rejects.toThrow('Both baseRef and headRef are required');
  });

  it('11. headRef only → throws', async () => {
    await expect(
      getChangedPathsFromGitDiff({ headRef: 'HEAD', runner: fakeRunner().runner }),
    ).rejects.toThrow('Both baseRef and headRef are required');
  });

  it('12. invalid baseRef → throws', async () => {
    await expect(
      getChangedPathsFromGitDiff({ baseRef: 'main; rm -rf /', headRef: 'HEAD', runner: fakeRunner().runner }),
    ).rejects.toThrow('Invalid git ref');
  });

  it('13. invalid headRef → throws', async () => {
    await expect(
      getChangedPathsFromGitDiff({ baseRef: 'main', headRef: 'HEAD | cat /etc/passwd', runner: fakeRunner().runner }),
    ).rejects.toThrow('Invalid git ref');
  });

  it('14. staged + baseRef → throws (mutually exclusive)', async () => {
    await expect(
      getChangedPathsFromGitDiff({ staged: true, baseRef: 'main', runner: fakeRunner().runner }),
    ).rejects.toThrow('Cannot specify both staged and baseRef');
  });
});

// ============================================================================
// getChangedPathsFromGitDiff — includeUntracked
// ============================================================================

describe('getChangedPathsFromGitDiff — includeUntracked', () => {
  it('15. calls git ls-files --others --exclude-standard', async () => {
    const { runner, calls } = fakeRunner(''); // diff 和 ls-files 都返回空
    await getChangedPathsFromGitDiff({ includeUntracked: true, runner });
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(['ls-files', '--others', '--exclude-standard']);
  });

  it('16. merges diff + untracked preserving order and deduping', async () => {
    let callIndex = 0;
    const runner: GitCommandRunner = async () => {
      callIndex++;
      if (callIndex === 1) return { stdout: 'src/a.ts\nsrc/b.ts', stderr: '' };
      return { stdout: 'src/b.ts\nsrc/c.ts', stderr: '' };
    };

    const result = await getChangedPathsFromGitDiff({ includeUntracked: true, runner });
    // src/a.ts (diff), src/b.ts (diff, untracked duplicate skipped), src/c.ts (untracked new)
    expect(result).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });
});

// ============================================================================
// getChangedPathsFromGitDiff — options passthrough
// ============================================================================

describe('getChangedPathsFromGitDiff — options', () => {
  it('17. cwd is passed to runner', async () => {
    const { runner, calls } = fakeRunner('');
    await getChangedPathsFromGitDiff({ cwd: '/custom/path', runner });
    expect(calls[0].options.cwd).toBe('/custom/path');
  });

  it('18. runner failure throws clear error', async () => {
    await expect(
      getChangedPathsFromGitDiff({ runner: failingRunner('spawn git ENOENT') }),
    ).rejects.toThrow('Failed to read git changed paths: spawn git ENOENT');
  });

  it('19. empty stdout returns empty array', async () => {
    const { runner } = fakeRunner('');
    const result = await getChangedPathsFromGitDiff({ runner });
    expect(result).toEqual([]);
  });

  it('20. stderr output does not cause failure when exit is ok', async () => {
    const { runner } = fakeRunner('src/file.ts', 'warning: some warning');
    const result = await getChangedPathsFromGitDiff({ runner });
    // stdout is parsed normally, stderr ignored when no error
    expect(result).toEqual(['src/file.ts']);
  });
});
