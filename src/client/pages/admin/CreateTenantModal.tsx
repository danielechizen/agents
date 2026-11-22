import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FormField, Input } from "@/client/components";
import {
  Modal,
  ModalCancelButton,
  type ModalController,
  useOnModalOpen,
} from "@/client/components/Modal";
import { notifyTenantsChanged } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { clipText } from "@/lib/text";

function slugify(name: string): string {
  const slug = clipText(
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/g, ""),
    100,
  ).replace(/-+$/g, "");
  return slug || "tenant";
}

export function CreateTenantModal({
  modal,
  onCreated,
}: {
  modal: ModalController;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useOnModalOpen(modal, () => {
    setName("");
    setSlug("");
    setSlugTouched(false);
    setError(null);
    setBusy(false);
  });

  function refuseEmpty(nextName: string, nextSlug: string): boolean {
    if (nextName && nextSlug) return false;
    setError(t("tenant.required", "Name and slug are required."));
    return true;
  }

  async function submit() {
    const nextName = name.trim();
    const nextSlug = (slugTouched ? slug : slugify(name)).trim();
    if (refuseEmpty(nextName, nextSlug)) return;
    setBusy(true);
    setError(null);
    const { error: failed } = await api.api.v1.tenants.post({
      name: nextName,
      slug: nextSlug,
    });
    setBusy(false);
    if (failed) {
      setError(
        failed.status === 409
          ? t("tenant.slugInUse", "This slug is already in use.")
          : apiErrorMessage(failed) ||
              t("tenant.createFailed", "Could not create the tenant."),
      );
      return;
    }
    notifyTenantsChanged();
    onCreated();
    modal.close();
  }

  return (
    <Modal
      modal={modal}
      title={t("tenant.create", "Create tenant")}
      busy={busy}
      unsavedChanges={name.trim() !== "" || slug.trim() !== ""}
      footer={
        <>
          <ModalCancelButton disabled={busy} />
          <Button loading={busy} onClick={() => void submit()}>
            {t("tenant.create", "Create tenant")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label={t("tenant.name", "Name")} required>
          <Input
            value={name}
            maxLength={200}
            onChange={(e) => {
              const next = e.target.value;
              setName(next);
              if (!slugTouched) setSlug(slugify(next));
            }}
          />
        </FormField>
        <FormField
          label={t("tenant.slug", "Slug")}
          required
          description={t(
            "tenant.slugHint",
            "Lowercase letters, digits and hyphens. It identifies the tenant and does not change later.",
          )}
          error={error}
        >
          <Input
            value={slugTouched ? slug : slug || slugify(name)}
            maxLength={100}
            spellCheck={false}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </FormField>
      </div>
    </Modal>
  );
}
