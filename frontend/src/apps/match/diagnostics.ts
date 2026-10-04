// Only serialize on request; routine sampling stays bounded in the match owner.
export function exportDiagnostics(snapshot: object): void {
  const data = new Blob(
    [
      JSON.stringify(
        {
          format: 'baboreborn-match-diagnostics-v1',
          recordedAt: new Date().toISOString(),
          ...snapshot,
        },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = `baboreborn-diagnostics-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
