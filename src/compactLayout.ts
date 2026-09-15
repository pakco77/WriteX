export async function applyCompactTheme(input: {
  state: { themeId?: string };
  persist: () => Promise<void>;
}): Promise<void> {
  const previous = input.state.themeId;
  input.state.themeId = "compact";
  try {
    await input.persist();
  } catch (error) {
    if (previous === undefined) delete input.state.themeId;
    else input.state.themeId = previous;
    throw error;
  }
}
