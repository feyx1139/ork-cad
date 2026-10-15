// Messages between the page (main.ts) and the CAD worker (worker.ts).

import type { DetailShape, MatchView, PartView, RocketView, SpacesView } from "./session.ts";

export type Request =
  | { id: number; type: "open"; bytes: ArrayBuffer; fileName: string }
  | { id: number; type: "setDetails"; key: string; details: string }
  | { id: number; type: "file"; key: string; format: "stl" | "step" }
  | { id: number; type: "zip" }
  | { id: number; type: "rocketStep" }
  | { id: number; type: "save" }
  | { id: number; type: "compare"; key: string; bytes: ArrayBuffer; fileName: string; flip?: boolean }
  | { id: number; type: "applyMatch"; key: string }
  | { id: number; type: "detailShape"; key: string; index: number };

/** Requests without the id, which the page adds. */
export type RequestBody = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

export type Message =
  | { type: "progress"; text: string }
  | { type: "rocket"; rocket: RocketView; partCount: number }
  | { type: "part"; part: PartView; done?: number; total?: number }
  | { type: "spaces"; spaces: SpacesView }
  | { id: number; type: "done" }
  | { id: number; type: "file"; name: string; bytes: ArrayBuffer }
  | { id: number; type: "match"; match: MatchView }
  | { id: number; type: "detailShape"; shape: DetailShape }
  | { id: number; type: "error"; message: string };
