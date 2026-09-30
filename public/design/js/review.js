import { buildFiles } from "./files.js";
import { buildSpec, summarize } from "./spec.js";

const $ = (id) => document.getElementById(id);

export function renderReview(s) {
  const { spec, error } = buildSpec(s);
  $("summary").textContent = error ?? summarize(spec);
  const box = $("downloads");
  box.replaceChildren();
  if (error) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "secondary";
  b.textContent = "Prepare files";
  b.addEventListener("click", async () => {
    b.disabled = true;
    b.textContent = "Preparing…";
    try {
      const files = await buildFiles(s, buildSpec(s).spec);
      box.replaceChildren(
        ...files.map((f) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(f.blob);
          a.download = f.name;
          a.className = "chip";
          a.textContent = f.name;
          return a;
        }),
      );
      box.querySelector("a")?.focus();
    } catch (err) {
      b.disabled = false;
      b.textContent = "Prepare files";
      $("notice").textContent = err.message;
    }
  });
  box.append(b);
}
