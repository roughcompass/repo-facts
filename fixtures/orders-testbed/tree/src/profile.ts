export async function loadProfile() {
  const response = await fetch("/api/profile", { credentials: "include" });
  return response.json();
}
