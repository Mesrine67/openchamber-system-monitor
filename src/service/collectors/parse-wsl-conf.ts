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

/** Set a validated INI-like WSL setting while preserving unrelated lines and comments. */
export const withWslConfigSetting = (input: string, sectionName: string, keyName: string, value: string): string => {
  if (!/^[a-z][a-z0-9]*$/i.test(sectionName) || !/^[a-z][a-z0-9]*$/i.test(keyName)
    || /[\r\n\0]/.test(value) || value.length > 4096) throw new Error('Invalid WSL configuration setting.');

  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const targetSection = sectionName.toLocaleLowerCase();
  const targetKey = keyName.toLocaleLowerCase();
  const output: string[] = [];
  let section = '';
  let foundSection = false;
  let wroteValue = false;

  for (const line of lines) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if (heading) {
      if (section === targetSection && !wroteValue) {
        output.push(`${keyName}=${value}`);
        wroteValue = true;
      }
      section = heading[1]!.trim().toLocaleLowerCase();
      if (section === targetSection) foundSection = true;
      output.push(line);
      continue;
    }
    if (section === targetSection) {
      const assignment = line.match(/^(\s*)([A-Za-z][A-Za-z0-9]*)(\s*=\s*)(.*)$/);
      if (assignment?.[2]?.toLocaleLowerCase() === targetKey) {
        const inlineComment = /\s+[;#].*$/.exec(assignment[4]!)?.[0] ?? '';
        if (!wroteValue) output.push(`${assignment[1]}${assignment[2]}${assignment[3]}${value}${inlineComment}`);
        wroteValue = true;
        continue;
      }
    }
    output.push(line);
  }

  if (section === targetSection && !wroteValue) {
    output.push(`${keyName}=${value}`);
    wroteValue = true;
  }
  if (!foundSection) {
    while (output.at(-1) === '') output.pop();
    if (output.length > 0) output.push('');
    output.push(`[${sectionName}]`, `${keyName}=${value}`);
  }
  return `${output.join('\n').replace(/\n+$/, '')}\n`;
};
