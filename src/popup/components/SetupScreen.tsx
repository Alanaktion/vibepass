/** First run: ask for the self-hosted server URL and email. Wired up in Phase 0. */
export function SetupScreen() {
  return (
    <main class="screen">
      <h1>Vibepass</h1>
      <p class="muted">Connect to your self-hosted Bitwarden or Vaultwarden server.</p>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <label>
          Server URL
          <input type="url" name="serverUrl" placeholder="https://vault.example.com" required />
        </label>
        <label>
          Email
          <input type="email" name="email" autocomplete="username" required />
        </label>
        <button type="submit" disabled>
          Continue
        </button>
      </form>
    </main>
  );
}
