import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { getAllSettings } from "@/lib/settings";
import { SectionHeading } from "../../ui";
import IdentityForm from "./IdentityForm";
import Touch1Editor from "./Touch1Editor";
import BumpEditor from "./BumpEditor";

// Where Touch 1 / Touch 1.5 copy and the sender identity are edited — moved
// out of worker/lib/outreachEmail.ts and into app_settings so neither needs a
// deploy to change. See lib/settings.ts for the stored shape.
export const dynamic = "force-dynamic";

const FALLBACK_RESTAURANT = {
  name: "Casa del Sol",
  contactFirstName: "Maria" as string | null,
  signatureDish: "ropa vieja",
  city: "Miami, FL" as string | null,
};

// The most recently sourced restaurant with a signature dish on file — a real,
// representative preview subject. Falls back to a canned example so the page
// never breaks on an empty/fresh database.
async function getPreviewRestaurant() {
  const [r] = await db
    .select({
      name: restaurants.name,
      contactFirstName: restaurants.contactFirstName,
      signatureDish: restaurants.signatureDish,
      city: restaurants.city,
    })
    .from(restaurants)
    .where(isNotNull(restaurants.signatureDish))
    .orderBy(desc(restaurants.createdAt))
    .limit(1);
  return r ? { ...r, signatureDish: r.signatureDish! } : FALLBACK_RESTAURANT;
}

async function getPendingDraftCount(): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), eq(outreachJobs.status, "draft"), isNull(outreachJobs.sentAt)));
  return n ?? 0;
}

export default async function TemplatesPage() {
  const [{ values }, previewRestaurant, pendingDrafts] = await Promise.all([
    getAllSettings(),
    getPreviewRestaurant(),
    getPendingDraftCount(),
  ]);

  const identity = { senderName: values.outreach_sender_name, postalAddress: values.outreach_postal_address };

  return (
    <div className="flex flex-col gap-10">
      <section>
        <SectionHeading>Identity</SectionHeading>
        <div className="mt-3">
          <IdentityForm senderName={values.outreach_sender_name} postalAddress={values.outreach_postal_address} />
        </div>
      </section>

      <section>
        <SectionHeading>Touch 1 &amp; Touch 1.5</SectionHeading>
        <p className="mt-1 max-w-2xl text-sm text-stone-600">
          Editing here changes what the worker composes on its next run — no deploy needed. Touch 2
          (the enhanced-photo delivery) is locked copy and isn&apos;t editable, since it carries the
          approved pricing pitch.
        </p>
        <div className="mt-4 flex flex-col gap-6">
          <Touch1Editor
            initialTemplate={values.outreach_touch1_template}
            identity={identity}
            previewRestaurant={previewRestaurant}
            pendingDrafts={pendingDrafts}
          />
          <BumpEditor
            initialTemplate={values.outreach_bump_template}
            identity={identity}
            previewRestaurant={previewRestaurant}
          />
        </div>
      </section>
    </div>
  );
}
