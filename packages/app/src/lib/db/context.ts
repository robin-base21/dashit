import { createContext } from "svelte";
import type { Db } from "./client.svelte";

export const [getDb, setDb] = createContext<Db>();
