interface GithubTarget {
  owner: string;
  repo: string;
  token: string;
}

async function githubRequest<T>(
  target: GithubTarget,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function postPrComment(
  target: GithubTarget,
  prNumber: number,
  body: string,
): Promise<{ id: number }> {
  return githubRequest(target, `/repos/${target.owner}/${target.repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function updatePrComment(target: GithubTarget, commentId: number, body: string): Promise<void> {
  await githubRequest(target, `/repos/${target.owner}/${target.repo}/issues/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

export async function addLabels(target: GithubTarget, prNumber: number, labels: string[]): Promise<void> {
  await githubRequest(target, `/repos/${target.owner}/${target.repo}/issues/${prNumber}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels }),
  });
}

export async function openPromotionPr(
  target: GithubTarget,
  base: string,
  head: string,
  title: string,
  body: string,
): Promise<{ html_url: string; number: number }> {
  return githubRequest(target, `/repos/${target.owner}/${target.repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body }),
  });
}

export interface ChangedFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
}

/** Lists files changed in a PR (paginated, capped at 1000 files — plenty for scoping test generation / mutation testing). */
export async function listChangedFiles(target: GithubTarget, prNumber: number): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubRequest<ChangedFile[]>(
      target,
      `/repos/${target.owner}/${target.repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

export function githubTargetFromEnv(): GithubTarget {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY; // "owner/repo"
  if (!token || !repository) {
    throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set to talk to the GitHub API.");
  }
  const [owner, repo] = repository.split("/");
  return { owner, repo, token };
}
