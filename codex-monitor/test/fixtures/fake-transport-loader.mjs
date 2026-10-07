export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/src/app-server-client.mjs")) {
    return { url: new URL("./fake-transport.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
