interface Configuration {
  appId: string;
  sessionId: string;
  endpoint: string;
}

let configuration: Configuration | null = null;

export function init(options: Configuration) {
  configuration = options;
}

export async function track(name: string, properties: Record<string, unknown>) {
  if (!configuration) throw new Error("init() must be called first");
  const response = await fetch(configuration.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, properties, appId: configuration.appId }),
  });
  return response.ok;
}
