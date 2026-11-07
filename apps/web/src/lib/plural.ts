/** "1 employee", "2 employees" (#307). Pass the plural when it isn't +s. */
export function count(n: number, singular: string, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}
