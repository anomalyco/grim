// Rebuilds src/client/landing/wall/knuckler.glb from the monster artifact (website/artifacts/grim-monster/astra/monster.glb):
// drops the two meshes the cel look hides and the vertex colours it repaints, simplifies the body to 30%, resamples
// the clips and meshopt-compresses it. Needs glTF Transform, not a dependency of this repo:
//   npm i @gltf-transform/cli@4 && node scripts/landing-monster-glb.mjs <monster.glb> src/client/landing/wall/knuckler.glb
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { weld, simplify, resample, prune, dedup, meshopt } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
const [src, out, ratio = "0.3"] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
const doc = await io.read(src);
for (const n of doc.getRoot().listNodes()) {
  const m = n.getMesh();
  if (!m) continue;
  if (/Skin_(0\.91|1\.00)/.test(n.getName())) { n.dispose(); m.dispose(); continue; }
  for (const p of m.listPrimitives()) p.getAttribute("COLOR_0")?.dispose();
}
await MeshoptSimplifier.ready;
await doc.transform(prune(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Number(ratio), error: 0.0015 }), resample(), dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: "high" }));
await io.write(out, doc);
