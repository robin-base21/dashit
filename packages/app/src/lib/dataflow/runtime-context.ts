import { createContext } from "svelte";
import { DatasourceRuntime } from "./runtime.svelte";

export { DatasourceRuntime };
export const [getRuntime, setRuntime] = createContext<DatasourceRuntime>();
