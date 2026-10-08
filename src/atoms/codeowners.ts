/**
 * 解析 CODEOWNERS 文本,返回所有出现过的 owner(小写)。
 * 行格式:`<pattern> <owner> [<owner>...]`;`#` 起为注释;owner 形如 @user、@org/team 或邮箱。
 */
export function parseCodeowners(text: string): Set<string> {
  const owners = new Set<string>();
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    const tokens = line.split(/\s+/).slice(1);
    for (const t of tokens) owners.add(t.toLowerCase());
  }
  return owners;
}
