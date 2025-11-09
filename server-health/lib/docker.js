import { exec } from "node:child_process";
import { promisify } from "node:util";

const sh = promisify(exec);

/**
 * Execute a shell command
 */
export async function cmd(command, opts = {}) {
  try {
    const { stdout } = await sh(command, { timeout: 4000, shell: "/bin/sh", ...opts });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || "").toString().trim(),
      err: (e.stderr || e.message || "").toString().trim()
    };
  }
}

/**
 * Inspect a Docker container using Go template
 */
export async function dockerInspect(path, containerName) {
  const query = `docker inspect -f '{{json ${path}}}' ${containerName}`;
  const result = await cmd(query);
  if (!result.ok || !result.out) return null;
  try {
    return JSON.parse(result.out);
  } catch {
    return null;
  }
}

/**
 * Get environment variables from a Docker container
 */
export async function dockerEnvMap(containerName) {
  const result = await cmd(`docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${containerName}`);
  if (!result.ok) return {};

  return result.out.split(/\n+/).reduce((map, line) => {
    const index = line.indexOf("=");
    if (index > 0) {
      map[line.slice(0, index)] = line.slice(index + 1);
    }
    return map;
  }, {});
}

/**
 * Get the IP address of a container on a specific network
 */
export async function getContainerIP(containerName, networkName = "servarr_media") {
  const networks = await dockerInspect(".NetworkSettings.Networks", containerName);
  if (!networks || typeof networks !== 'object') return null;

  // Try the specified network first
  if (networks[networkName]?.IPAddress) {
    return networks[networkName].IPAddress;
  }

  // Fall back to any available network
  for (const net of Object.values(networks)) {
    if (net?.IPAddress) return net.IPAddress;
  }

  return null;
}

/**
 * Get the egress IP of a container
 */
export async function getEgressIP(containerName) {
  const result = await cmd(
    `docker exec ${containerName} sh -c 'busybox wget -qO- https://ifconfig.io || wget -qO- https://ifconfig.io || curl -s https://ifconfig.io'`
  );
  return result.ok ? result.out.split(/\s+/)[0] : "";
}
