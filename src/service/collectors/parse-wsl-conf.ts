/** Updates the login user without discarding other per-distribution WSL settings. */
export const withDefaultWslUser = (input: string, username: string): string => {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) throw new Error('Invalid Linux username.');

  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let inUserSection = false;
  let foundUserSection = false;
  let wroteDefault = false;

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if (section) {
      if (inUserSection && !wroteDefault) {
        output.push(`default=${username}`);
        wroteDefault = true;
      }
      inUserSection = section[1]?.trim().toLocaleLowerCase() === 'user';
      if (inUserSection) foundUserSection = true;
      wroteDefault = false;
      output.push(line);
      continue;
    }

    if (inUserSection) {
      const value = line.match(/^(\s*default\s*=\s*).*$/i);
      if (value) {
        output.push(`${value[1]}${username}`);
        wroteDefault = true;
        continue;
      }
    }
    output.push(line);
  }

  if (inUserSection && !wroteDefault) output.push(`default=${username}`);
  if (!foundUserSection) {
    while (output.at(-1) === '') output.pop();
    if (output.length > 0) output.push('');
    output.push('[user]', `default=${username}`);
  }

  return `${output.join('\n').replace(/\n+$/, '')}\n`;
};
