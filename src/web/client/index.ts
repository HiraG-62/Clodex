import { type ClientDeps, clientMain } from "./client-main.js";

const config = document.getElementById("clodex-config");
if (!config?.textContent) throw new Error("Missing clodex config");
clientMain(JSON.parse(config.textContent) as ClientDeps);
