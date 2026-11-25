/// <reference lib="webworker" />
import { createLabHost, type LabIn } from '../core/labHost';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const handle = createLabHost((m) => scope.postMessage(m));
scope.onmessage = (e: MessageEvent<LabIn>) => handle(e.data);
