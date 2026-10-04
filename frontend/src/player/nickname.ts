// ASCII nicknames have at most 20 characters. Each color occupies six hex digits;
// ------ inherits the surface's default. Empty/absent decoration means all default.
export function validNicknameColors(value: unknown, nickname: string): value is string | undefined {
  return (
    value === undefined ||
    value === '' ||
    (typeof value === 'string' &&
      value.length === nickname.length * 6 &&
      /^(?:[0-9a-f]{6}|------){1,20}$/.test(value))
  );
}
export function nicknameRuns(nickname: string, colors?: string) {
  const runs: { text: string; color: string }[] = [];
  for (let i = 0; i < nickname.length; i++) {
    const token = colors?.slice(i * 6, i * 6 + 6);
    const color = token && token !== '------' ? `#${token}` : '';
    const previous = runs.at(-1);
    if (previous?.color === color) previous.text += nickname[i];
    else runs.push({ text: nickname[i]!, color });
  }
  return runs;
}
// Keep colors attached to the unchanged prefix/suffix; inserted text starts default.
export function editNicknameColors(before: string, after: string, colors = ''): string {
  if (!colors || before === after) return colors;
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(before.length, after.length) - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  return (
    colors.slice(0, prefix * 6) +
    '------'.repeat(after.length - prefix - suffix) +
    (suffix ? colors.slice(-suffix * 6) : '')
  );
}
