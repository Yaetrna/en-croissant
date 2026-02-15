import { type GoMode, commands } from "@/bindings";
import { enginesAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Slider,
  Stack,
  Text,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useAtomValue } from "jotai";
import { memo, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

interface BatchAnalysisModalProps {
  opened: boolean;
  onClose: () => void;
  dbPath: string;
  progressId: string;
  setInProgress: (v: boolean) => void;
}

function BatchAnalysisModal({
  opened,
  onClose,
  dbPath,
  progressId,
  setInProgress,
}: BatchAnalysisModalProps) {
  const { t } = useTranslation();
  const engines = useAtomValue(enginesAtom);
  const localEngines = useMemo(
    () => engines.filter((e): e is LocalEngine => e.type === "local"),
    [engines],
  );

  const form = useForm({
    initialValues: {
      engine: "",
      goMode: { t: "Depth", c: 16 } as Exclude<GoMode, { t: "Infinite" }>,
      numWorkers: 2,
    },
    validate: {
      engine: (value) => {
        if (!value) return t("Board.Analysis.EngineRequired");
      },
    },
  });

  // Sync engine selection when engines load
  useEffect(() => {
    if (localEngines.length > 0 && !form.values.engine) {
      form.setFieldValue("engine", localEngines[0].id);
    }
  }, [localEngines]);

  function startAnalysis() {
    const engine = localEngines.find((e) => e.id === form.values.engine);
    if (!engine) return;

    setInProgress(true);
    onClose();

    commands
      .analyzeDatabase(progressId, dbPath, {
        engine: engine.path,
        goMode: form.values.goMode,
        numWorkers: form.values.numWorkers,
      })
      .then((result) => {
        if (result.status === "ok") {
          notifications.show({
            title: t("Databases.BatchAnalysis.Title"),
            message: `${result.data} ${t("Common.Games").toLowerCase()} analyzed`,
            color: "green",
          });
        } else {
          notifications.show({
            title: t("Databases.BatchAnalysis.Title"),
            message: result.error,
            color: "red",
          });
        }
      })
      .finally(() => {
        setInProgress(false);
      });
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("Databases.BatchAnalysis.Title")}
    >
      <form onSubmit={form.onSubmit(() => startAnalysis())}>
        <Stack>
          <Select
            allowDeselect={false}
            withAsterisk
            label={t("Common.Engine")}
            placeholder="Pick one"
            data={
              localEngines.map((engine) => ({
                value: engine.id,
                label: engine.name,
              })) ?? []
            }
            {...form.getInputProps("engine")}
          />
          <Group wrap="nowrap">
            <Select
              allowDeselect={false}
              comboboxProps={{
                position: "bottom",
                middlewares: { flip: false, shift: false },
              }}
              data={[
                { label: t("GoMode.Depth"), value: "Depth" },
                { label: t("Board.Analysis.Time"), value: "Time" },
                { label: t("GoMode.Nodes"), value: "Nodes" },
              ]}
              value={form.values.goMode.t}
              onChange={(v) => {
                const newGo = form.values.goMode;
                newGo.t = v as "Depth" | "Time" | "Nodes";
                form.setFieldValue("goMode", newGo);
              }}
            />
            <NumberInput
              min={1}
              value={form.values.goMode.c as number}
              onChange={(v) =>
                form.setFieldValue("goMode", {
                  ...(form.values.goMode as any),
                  c: (v || 1) as number,
                })
              }
            />
          </Group>

          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Databases.BatchAnalysis.Workers")}
            </Text>
            <Slider
              min={1}
              max={8}
              step={1}
              marks={[
                { value: 1, label: "1" },
                { value: 2, label: "2" },
                { value: 4, label: "4" },
                { value: 8, label: "8" },
              ]}
              {...form.getInputProps("numWorkers")}
            />
          </div>

          <Group justify="right" mt="md">
            <Button type="submit">{t("Board.Analysis.Analyze")}</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export default memo(BatchAnalysisModal);
