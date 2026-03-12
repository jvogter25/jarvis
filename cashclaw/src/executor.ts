import type { SkillType } from './analyze.js';
import { runSeoAudit } from './skills/seo-audit.js';
import { runContentWriting } from './skills/content-writing.js';
import { runCodeReview } from './skills/code-review.js';
import { runCompetitorResearch } from './skills/competitor-research.js';
import { runLandingPageCopy } from './skills/landing-page-copy.js';

export async function executeSkill(skill: SkillType, target: string): Promise<string> {
  console.log(`[executor] Running skill=${skill} target=${target}`);

  switch (skill) {
    case 'seo_audit':
      return runSeoAudit(target);
    case 'content_writing':
      return runContentWriting(target);
    case 'code_review':
      return runCodeReview(target);
    case 'competitor_research':
      return runCompetitorResearch(target);
    case 'landing_page_copy':
      return runLandingPageCopy(target);
    default:
      throw new Error(`Unknown skill: ${skill}`);
  }
}
