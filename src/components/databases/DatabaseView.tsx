import { commands } from "@/bindings";
import GameTable from "@/components/databases/GameTable";
import PlayerTable from "@/components/databases/PlayerTable";
import ProgressButton from "@/components/common/ProgressButton";
import {
  type DatabaseViewStore,
  activeDatabaseViewStore,
  useActiveDatabaseViewStore,
} from "@/state/store/database";
import { ActionIcon, Box, Group, Stack, Tabs, Title } from "@mantine/core";
import {
  IconArrowBackUp,
  IconChess,
  IconTrophy,
  IconUser,
  IconZoomCheck,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import BatchAnalysisModal from "./BatchAnalysisModal";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import TournamentTable from "./TournamentTable";

function DatabaseView() {
  const { t } = useTranslation();
  const database = useActiveDatabaseViewStore((s) => s.database);
  const databaseTitle = useActiveDatabaseViewStore((s) => s.database?.title)!;
  const mode = useActiveDatabaseViewStore((s) => s.activeTab);
  const clearDatabase = useActiveDatabaseViewStore((s) => s.clearDatabase);
  const setActiveTab = useActiveDatabaseViewStore((s) => s.setActiveTab);

  const [batchModalOpened, setBatchModalOpened] = useState(false);
  const [batchInProgress, setBatchInProgress] = useState(false);

  const progressId = useMemo(
    () => `batch_analysis_${database?.file ?? ""}`,
    [database?.file],
  );

  const handleCancelBatch = useCallback(() => {
    commands.cancelAnalysis(progressId);
  }, [progressId]);

  return (
    <Box p="sm" h="100%">
      {database && (
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <Stack h="100%" style={{ overflow: "hidden" }}>
            <Group align="center">
              <Link onClick={() => clearDatabase()} to={"/databases"}>
                <ActionIcon variant="default">
                  <IconArrowBackUp size="1rem" />
                </ActionIcon>
              </Link>
              <Title>{databaseTitle}</Title>
              <div style={{ marginLeft: "auto", maxWidth: 250 }}>
                <ProgressButton
                  id={progressId}
                  redoable
                  leftIcon={<IconZoomCheck size="0.875rem" />}
                  onClick={() => setBatchModalOpened(true)}
                  onCancel={handleCancelBatch}
                  initInstalled={false}
                  labels={{
                    action: t("Databases.BatchAnalysis.Action"),
                    completed: t("Databases.BatchAnalysis.Completed"),
                    inProgress: t("Databases.BatchAnalysis.InProgress"),
                  }}
                  inProgress={batchInProgress}
                  setInProgress={setBatchInProgress}
                />
              </div>
            </Group>
            <BatchAnalysisModal
              opened={batchModalOpened}
              onClose={() => setBatchModalOpened(false)}
              dbPath={database.file}
              progressId={progressId}
              setInProgress={setBatchInProgress}
            />
            <Tabs
              value={mode}
              onChange={(value) =>
                setActiveTab(
                  (value ?? "games") as DatabaseViewStore["activeTab"],
                )
              }
              flex={1}
              style={{
                display: "flex",
                overflow: "hidden",
                flexDirection: "column",
              }}
            >
              <Tabs.List>
                <Tabs.Tab leftSection={<IconChess size="1rem" />} value="games">
                  {t("Common.Games")}
                </Tabs.Tab>
                <Tabs.Tab
                  leftSection={<IconUser size="1rem" />}
                  value="players"
                >
                  {t("Databases.Card.Players")}
                </Tabs.Tab>
                <Tabs.Tab
                  leftSection={<IconTrophy size="1rem" />}
                  value="tournaments"
                >
                  {t("Databases.Settings.Events")}
                </Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel
                value="games"
                flex={1}
                style={{ overflow: "hidden" }}
                pt="md"
              >
                <GameTable />
              </Tabs.Panel>
              <Tabs.Panel
                value="players"
                flex={1}
                style={{ overflow: "hidden" }}
                pt="md"
              >
                <PlayerTable />
              </Tabs.Panel>
              <Tabs.Panel
                value="tournaments"
                flex={1}
                style={{ overflow: "hidden" }}
                pt="md"
              >
                <TournamentTable />
              </Tabs.Panel>
            </Tabs>
          </Stack>
        </DatabaseViewStateContext.Provider>
      )}
    </Box>
  );
}

export default DatabaseView;
