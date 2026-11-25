/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';

/**
 * Conservative check: does this shell command mention AFOT's state directory
 * (auth.json, config.json, path grants)? Used to force a prompt even when
 * YOLO / auto-approve is on, because a tool that can edit config.json can
 * silently widen its own permissions or read stored API keys.
 *
 * False positives (a project's own ".afot" folder) just cost one prompt.
 */
export function commandMentionsAfotDir(
  command: string,
  afotDir: string,
  homeDir: string = os.homedir(),
): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const cmd = norm(command);
  const dir = norm(afotDir).replace(/\/+$/, '');
  if (dir && cmd.includes(dir)) return true;
  const home = norm(homeDir).replace(/\/+$/, '');
  if (home && dir.startsWith(home + '/')) {
    const rel = dir.slice(home.length + 1); // ".afot"
    if (cmd.includes('~/' + rel) || cmd.includes('$home/' + rel)) return true;
    if (cmd.includes('${home}/' + rel)) return true;
    if (cmd.includes('%userprofile%/' + rel)) return true;
    if (cmd.includes('$env:userprofile/' + rel)) return true;
  }
  if (/\$\{?afot_home\}?|%afot_home%|\$env:afot_home/.test(cmd)) return true;
  // Any path component named ".afot" (also catches cd ~ && cat .afot/auth.json).
  return /(^|[\s/"'=\\])\.afot(?![\w.-])/.test(cmd);
}
