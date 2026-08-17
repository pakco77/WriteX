import { planWeChatImage, type ImageInspection } from "./images.ts";

export type ImageProblemStatus = "ready" | "repairable" | "unrepairable";

export interface ImageProblemInput {
  source: string;
  inspection: ImageInspection;
  articleIndex?: number;
  total?: number;
}

export interface ImageProblem {
  source: string;
  inspection: ImageInspection;
  articleIndex?: number;
  total?: number;
  articleLabel?: string;
  status: ImageProblemStatus;
  reason: string;
  canExcludeFromCopy: boolean;
}

export function missingImageInspection(reason: string): ImageInspection {
  return {
    mimeType: null,
    byteLength: 0,
    complete: false,
    animated: false,
    extensionMismatch: false,
    mimeMismatch: false,
    issues: [reason],
  };
}

export function describeImageProblem(input: ImageProblemInput): ImageProblem {
  const { inspection } = input;
  const articleLabel = input.articleIndex && input.total
    ? `正文图 ${input.articleIndex} / ${input.total}`
    : undefined;
  if (!inspection.mimeType || !inspection.complete) {
    return {
      ...input,
      articleLabel,
      status: "unrepairable",
      reason: inspection.issues[0] ?? "图片文件不完整、损坏或格式无法识别。",
      canExcludeFromCopy: true,
    };
  }
  const plan = planWeChatImage(inspection, "content");
  if (plan.status === "direct") {
    return {
      ...input,
      articleLabel,
      status: "ready",
      reason: "图片已通过本地检查。",
      canExcludeFromCopy: false,
    };
  }
  return {
    ...input,
    articleLabel,
    status: "repairable",
    reason: plan.reason
      ? `可通过转换或优化处理：${plan.reason}`
      : "图片可通过现有转换或优化流程处理。",
    canExcludeFromCopy: false,
  };
}

export function galleryProblemClass(problem: ImageProblem): string {
  return problem.status === "unrepairable" ? "is-image-problem" : "";
}

export function galleryProblemSummary(problems: ImageProblem[]): string {
  const blocking = problems.filter(problem => problem.status === "unrepairable").length;
  return `已检查 ${problems.length} 张 · ${blocking} 张需处理`;
}
