export async function runAndRecordAssistant<T>(run: () => Promise<T>, record: (result: T) => void): Promise<T> {
  const result = await run();
  record(result);
  return result;
}
