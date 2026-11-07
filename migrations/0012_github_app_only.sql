-- GitHub connects only through the Kunla GitHub App now (KD-34). The hand-made webhook secrets and
-- personal tokens are no longer read, so forget them rather than keep credentials lying around.
DELETE FROM settings WHERE key = 'github_webhook_secret' OR key LIKE 'github_webhook_secret:%'
  OR key = 'github_token' OR key LIKE 'github_token:%';
