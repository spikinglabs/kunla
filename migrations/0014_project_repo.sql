-- KD-42: each project (or the workspace) can name its code repository, so short mentions in
-- briefs ("PR #12", "acme/site#12", "!12") link to the right host: GitHub, GitHub Enterprise,
-- GitLab (gitlab.com or self-managed), Gitea/Forgejo or Bitbucket. Set on the Projects page, or
-- remembered from the git remote an agent reports. repo_forge NULL means guess from the host name.
ALTER TABLE projects ADD COLUMN repo_url TEXT;
ALTER TABLE projects ADD COLUMN repo_forge TEXT;
