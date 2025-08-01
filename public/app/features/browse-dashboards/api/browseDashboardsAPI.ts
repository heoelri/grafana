import { createApi } from '@reduxjs/toolkit/query/react';

import { AppEvents, isTruthy, locationUtil } from '@grafana/data';
import { t } from '@grafana/i18n';
import { config, getBackendSrv, isFetchError, locationService } from '@grafana/runtime';
import { Dashboard } from '@grafana/schema';
import { Spec as DashboardV2Spec } from '@grafana/schema/dist/esm/schema/dashboard/v2';
import { folderAPIv1beta1 as folderAPI } from 'app/api/clients/folder/v1beta1';
import { createBaseQuery, handleRequestError } from 'app/api/createBaseQuery';
import appEvents from 'app/core/app_events';
import { contextSrv } from 'app/core/core';
import { Resource, ResourceList } from 'app/features/apiserver/types';
import { getDashboardAPI } from 'app/features/dashboard/api/dashboard_api';
import { isDashboardV2Resource, isV1DashboardCommand, isV2DashboardCommand } from 'app/features/dashboard/api/utils';
import { SaveDashboardCommand } from 'app/features/dashboard/components/SaveDashboard/types';
import { dashboardWatcher } from 'app/features/live/dashboard/dashboardWatcher';
import { dispatch } from 'app/store/store';
import { PermissionLevelString } from 'app/types/acl';
import { SaveDashboardResponseDTO, ImportDashboardResponseDTO } from 'app/types/dashboard';
import { FolderListItemDTO, FolderDTO, DescendantCount, DescendantCountDTO } from 'app/types/folders';

import { getDashboardScenePageStateManager } from '../../dashboard-scene/pages/DashboardScenePageStateManager';
import { refetchChildren, refreshParents } from '../state/actions';
import { DashboardTreeSelection } from '../types';

import { isProvisionedDashboard, isProvisionedFolder } from './isProvisioned';
import { PAGE_SIZE } from './services';

interface DeleteItemsArgs {
  selectedItems: Omit<DashboardTreeSelection, 'panel' | '$all'>;
}

interface MoveItemsArgs extends DeleteItemsArgs {
  destinationUID: string;
}

export interface ImportInputs {
  name: string;
  type: string;
  value: string;
  pluginId?: string;
}

interface ImportOptions {
  dashboard: Dashboard;
  overwrite: boolean;
  inputs: ImportInputs[];
  folderUid: string;
}

interface RestoreDashboardArgs {
  dashboard: Resource<Dashboard | DashboardV2Spec>;
}

export interface ListFolderQueryArgs {
  page: number;
  parentUid: string | undefined;
  limit: number;
  permission?: PermissionLevelString;
}

export const browseDashboardsAPI = createApi({
  tagTypes: ['getFolder'],
  reducerPath: 'browseDashboardsAPI',
  baseQuery: createBaseQuery({ baseURL: '/api' }),
  endpoints: (builder) => ({
    listFolders: builder.query<FolderListItemDTO[], ListFolderQueryArgs>({
      providesTags: (result) =>
        result && result.length > 0
          ? result.map((folder) => ({ type: 'getFolder', id: folder.uid }))
          : [{ type: 'getFolder', id: 'EMPTY_RESULT' }],
      query: ({ parentUid, limit, page, permission }) => ({
        url: '/folders',
        params: { parentUid, limit, page, permission },
      }),
    }),

    // get folder info (e.g. title, parents) but *not* children
    getFolder: builder.query<FolderDTO, string>({
      providesTags: (_result, _error, folderUID) => [{ type: 'getFolder', id: folderUID }],
      query: (folderUID) => ({ url: `/folders/${folderUID}`, params: { accesscontrol: true } }),
    }),

    // create a new folder
    newFolder: builder.mutation<FolderDTO, { title: string; parentUid?: string }>({
      invalidatesTags: ['getFolder'],
      query: ({ title, parentUid }) => ({
        method: 'POST',
        url: '/folders',
        body: {
          title,
          parentUid,
        },
      }),
      onQueryStarted: ({ parentUid }, { queryFulfilled, dispatch }) => {
        queryFulfilled.then(async ({ data: folder }) => {
          await contextSrv.fetchUserPermissions();
          dispatch(
            refetchChildren({
              parentUID: parentUid,
              pageSize: PAGE_SIZE,
            })
          );
        });
      },
    }),

    // save an existing folder (e.g. rename)
    saveFolder: builder.mutation<FolderDTO, FolderDTO>({
      // because the getFolder calls contain the parents, renaming a parent/grandparent/etc needs to invalidate all child folders
      // we could do something smart and recursively invalidate these child folders but it doesn't seem worth it
      // instead let's just invalidate all the getFolder calls
      invalidatesTags: ['getFolder'],
      query: ({ uid, title, version }) => ({
        method: 'PUT',
        url: `/folders/${uid}`,
        body: {
          title,
          version,
        },
      }),
      onQueryStarted: ({ parentUid }, { queryFulfilled, dispatch }) => {
        queryFulfilled.then(() => {
          dispatch(
            refetchChildren({
              parentUID: parentUid,
              pageSize: PAGE_SIZE,
            })
          );
        });
      },
    }),

    // move an *individual* folder. used in the folder actions menu.
    moveFolder: builder.mutation<void, { folder: FolderDTO; destinationUID: string }>({
      invalidatesTags: ['getFolder'],
      query: ({ folder, destinationUID }) => ({
        url: `/folders/${folder.uid}/move`,
        method: 'POST',
        body: { parentUID: destinationUID },
      }),
      onQueryStarted: ({ folder, destinationUID }, { queryFulfilled, dispatch }) => {
        const { parentUid } = folder;
        queryFulfilled.then(() => {
          dispatch(
            refetchChildren({
              parentUID: parentUid,
              pageSize: PAGE_SIZE,
            })
          );
          dispatch(
            refetchChildren({
              parentUID: destinationUID,
              pageSize: PAGE_SIZE,
            })
          );
        });
      },
    }),

    // delete an *individual* folder. used in the folder actions menu.
    deleteFolder: builder.mutation<void, FolderDTO>({
      query: ({ uid }) => ({
        url: `/folders/${uid}`,
        method: 'DELETE',
        params: {
          // TODO: Once backend returns alert rule counts, set this back to true
          // when this is merged https://github.com/grafana/grafana/pull/67259
          forceDeleteRules: false,
        },
      }),
      onQueryStarted: ({ parentUid }, { queryFulfilled, dispatch }) => {
        queryFulfilled.then(() => {
          dispatch(
            refetchChildren({
              parentUID: parentUid,
              pageSize: PAGE_SIZE,
            })
          );
        });
      },
    }),

    // gets the descendant counts for a folder. used in the move/delete modals.
    getAffectedItems: builder.query<DescendantCount, DashboardTreeSelection>({
      // don't cache this data for now, since library panel/alert rule creation isn't done through rtk query
      keepUnusedDataFor: 0,
      queryFn: async (selectedItems) => {
        const folderUIDs = Object.keys(selectedItems.folder).filter((uid) => selectedItems.folder[uid]);

        const promises = folderUIDs.map((folderUID) => {
          return getBackendSrv().get<DescendantCountDTO>(`/api/folders/${folderUID}/counts`);
        });

        const results = await Promise.all(promises);

        const totalCounts = {
          folder: Object.values(selectedItems.folder).filter(isTruthy).length,
          dashboard: Object.values(selectedItems.dashboard).filter(isTruthy).length,
          libraryPanel: 0,
          alertRule: 0,
        };

        for (const folderCounts of results) {
          // TODO remove nullish coalescing once nestedFolders is toggled on
          totalCounts.folder += folderCounts.folder ?? 0;
          totalCounts.dashboard += folderCounts.dashboard;
          totalCounts.alertRule += folderCounts.alertrule;
          totalCounts.libraryPanel += folderCounts.librarypanel;
        }

        return { data: totalCounts };
      },
    }),

    // move *multiple* items (folders and dashboards). used in the move modal.
    moveItems: builder.mutation<void, MoveItemsArgs>({
      invalidatesTags: ['getFolder'],
      queryFn: async ({ selectedItems, destinationUID }, _api, _extraOptions, baseQuery) => {
        const selectedDashboards = Object.keys(selectedItems.dashboard).filter((uid) => selectedItems.dashboard[uid]);
        const selectedFolders = Object.keys(selectedItems.folder).filter((uid) => selectedItems.folder[uid]);

        // Move all the folders sequentially
        // TODO error handling here
        for (const folderUID of selectedFolders) {
          if (config.featureToggles.provisioning) {
            const folder = await dispatch(folderAPI.endpoints.getFolder.initiate({ name: folderUID }));
            if (isProvisionedFolder(folder.data)) {
              appEvents.publish({
                type: AppEvents.alertWarning.name,
                payload: ['Cannot move provisioned folder'],
              });
              continue;
            }
          }

          await baseQuery({
            url: `/folders/${folderUID}/move`,
            method: 'POST',
            body: { parentUID: destinationUID },
          });
        }

        // Move all the dashboards sequentially
        // TODO error handling here
        for (const dashboardUID of selectedDashboards) {
          const fullDash = await getDashboardAPI().getDashboardDTO(dashboardUID);
          const dashboard = isDashboardV2Resource(fullDash) ? fullDash.spec : fullDash.dashboard;
          const k8s = isDashboardV2Resource(fullDash) ? fullDash.metadata : undefined;

          if (config.featureToggles.provisioning) {
            if (isProvisionedDashboard(fullDash)) {
              appEvents.publish({
                type: AppEvents.alertWarning.name,
                payload: ['Cannot move provisioned dashboard'],
              });
              continue;
            }
          }
          await getDashboardAPI().saveDashboard({
            dashboard,
            folderUid: destinationUID,
            overwrite: false,
            message: '',
            k8s,
          });
        }
        return { data: undefined };
      },
      onQueryStarted: ({ destinationUID, selectedItems }, { queryFulfilled, dispatch }) => {
        const selectedDashboards = Object.keys(selectedItems.dashboard).filter((uid) => selectedItems.dashboard[uid]);
        const selectedFolders = Object.keys(selectedItems.folder).filter((uid) => selectedItems.folder[uid]);
        queryFulfilled.then(() => {
          dispatch(
            refetchChildren({
              parentUID: destinationUID,
              pageSize: PAGE_SIZE,
            })
          );
          dispatch(refreshParents([...selectedFolders, ...selectedDashboards]));
        });
      },
    }),

    // delete *multiple* items (folders and dashboards). used in the delete modal.
    deleteItems: builder.mutation<void, DeleteItemsArgs>({
      invalidatesTags: ['getFolder'],
      queryFn: async ({ selectedItems }, _api, _extraOptions, baseQuery) => {
        const selectedDashboards = Object.keys(selectedItems.dashboard).filter((uid) => selectedItems.dashboard[uid]);
        const selectedFolders = Object.keys(selectedItems.folder).filter((uid) => selectedItems.folder[uid]);
        const pageStateManager = getDashboardScenePageStateManager();
        // Delete all the folders sequentially
        // TODO error handling here
        for (const folderUID of selectedFolders) {
          if (config.featureToggles.provisioning) {
            const folder = await dispatch(folderAPI.endpoints.getFolder.initiate({ name: folderUID }));
            if (isProvisionedFolder(folder.data)) {
              appEvents.publish({
                type: AppEvents.alertWarning.name,
                payload: [
                  'Cannot delete provisioned folder. To remove it, delete it from the repository and synchronise to apply the changes.',
                ],
              });
              continue;
            }
          }
          await baseQuery({
            url: `/folders/${folderUID}`,
            method: 'DELETE',
            params: {
              // TODO: Once backend returns alert rule counts, set this back to true
              // when this is merged https://github.com/grafana/grafana/pull/67259
              forceDeleteRules: false,
            },
          });
        }
        // Delete all the dashboards sequentially
        // TODO error handling here
        for (const dashboardUID of selectedDashboards) {
          if (config.featureToggles.provisioning) {
            const dto = await getDashboardAPI().getDashboardDTO(dashboardUID);
            if (isProvisionedDashboard(dto)) {
              appEvents.publish({
                type: AppEvents.alertWarning.name,
                payload: [
                  'Cannot delete provisioned dashboard. To remove it, delete it from the repository and synchronise to apply the changes.',
                ],
              });

              continue;
            }
          }

          await getDashboardAPI().deleteDashboard(dashboardUID, true);

          pageStateManager.clearDashboardCache();
          pageStateManager.removeSceneCache(dashboardUID);

          // handling success alerts for these feature toggles
          // for legacy response, the success alert will be triggered by showSuccessAlert function in public/app/core/services/backend_srv.ts
          if (config.featureToggles.kubernetesDashboards) {
            appEvents.publish({
              type: AppEvents.alertSuccess.name,
              payload: ['Dashboard deleted'],
            });
          }
        }
        return { data: undefined };
      },
      onQueryStarted: ({ selectedItems }, { queryFulfilled, dispatch }) => {
        const selectedDashboards = Object.keys(selectedItems.dashboard).filter((uid) => selectedItems.dashboard[uid]);
        const selectedFolders = Object.keys(selectedItems.folder).filter((uid) => selectedItems.folder[uid]);
        queryFulfilled.then(() => {
          dispatch(refreshParents([...selectedFolders, ...selectedDashboards]));
        });
      },
    }),

    // save an existing dashboard
    saveDashboard: builder.mutation<SaveDashboardResponseDTO, SaveDashboardCommand<Dashboard | DashboardV2Spec>>({
      queryFn: async (cmd) => {
        try {
          if (isV2DashboardCommand(cmd)) {
            const response = await getDashboardAPI('v2').saveDashboard(cmd);
            return { data: response };
          }

          if (isV1DashboardCommand(cmd)) {
            const rsp = await getDashboardAPI().saveDashboard(cmd);
            return { data: rsp };
          }
          throw new Error('Invalid dashboard version');
        } catch (error) {
          return handleRequestError(error);
        }
      },

      onQueryStarted: ({ folderUid }, { queryFulfilled, dispatch }) => {
        dashboardWatcher.ignoreNextSave();
        queryFulfilled.then(async () => {
          await contextSrv.fetchUserPermissions();
          dispatch(
            refetchChildren({
              parentUID: folderUid,
              pageSize: PAGE_SIZE,
            })
          );
        });
      },
    }),

    importDashboard: builder.mutation<ImportDashboardResponseDTO, ImportOptions>({
      query: ({ dashboard, overwrite, inputs, folderUid }) => ({
        method: 'POST',
        url: '/dashboards/import',
        body: {
          dashboard,
          overwrite,
          inputs,
          folderUid,
        },
      }),
      onQueryStarted: async ({ dashboard, folderUid }, { queryFulfilled, dispatch }) => {
        // Check if a dashboard with this UID already exists to find its current folder
        let currentFolderUid: string | undefined;
        if (dashboard.uid) {
          try {
            const existingDashboard = await getDashboardAPI().getDashboardDTO(dashboard.uid);
            currentFolderUid = isDashboardV2Resource(existingDashboard)
              ? existingDashboard.metadata?.name
              : existingDashboard.meta?.folderUid;
          } catch (error) {
            if (isFetchError(error)) {
              if (error.status !== 404) {
                console.error('Error fetching dashboard', error);
              } else {
                // Do not show the error alert if the dashboard does not exist
                // this is expected when importing a new dashboard
                error.isHandled = true;
              }
            }
          }
        }

        queryFulfilled.then(async (response) => {
          // Refresh destination folder
          dispatch(
            refetchChildren({
              parentUID: folderUid,
              pageSize: PAGE_SIZE,
            })
          );

          // If the dashboard was moved from a different folder, refresh the source folder too
          if (currentFolderUid && currentFolderUid !== folderUid) {
            dispatch(
              refetchChildren({
                parentUID: currentFolderUid,
                pageSize: PAGE_SIZE,
              })
            );
          }

          const dashboardUrl = locationUtil.stripBaseFromUrl(response.data.importedUrl);
          locationService.push(dashboardUrl);
        });
      },
    }),

    // RTK wrapper for the dashboard API
    listDeletedDashboards: builder.query<ResourceList<Dashboard | DashboardV2Spec>, void>({
      queryFn: async () => {
        try {
          const api = getDashboardAPI();
          const response = await api.listDeletedDashboards({});

          return { data: response };
        } catch (error) {
          return handleRequestError(error);
        }
      },
    }),

    // restore a dashboard that got deleted
    restoreDashboard: builder.mutation<void, RestoreDashboardArgs>({
      queryFn: async ({ dashboard }) => {
        try {
          const api = getDashboardAPI();
          const response = await api.restoreDashboard(dashboard);
          const name = response.spec.title;

          if (name) {
            appEvents.publish({
              type: AppEvents.alertSuccess.name,
              payload: [t('browse-dashboards.restore.success', 'Dashboard {{name}} restored', { name })],
            });
          }

          return { data: undefined };
        } catch (error) {
          return handleRequestError(error);
        }
      },
    }),
  }),
});

export const {
  endpoints,
  useDeleteFolderMutation,
  useDeleteItemsMutation,
  useGetAffectedItemsQuery,
  useGetFolderQuery,
  useLazyGetFolderQuery,
  useMoveFolderMutation,
  useMoveItemsMutation,
  useNewFolderMutation,
  useSaveDashboardMutation,
  useSaveFolderMutation,
  useRestoreDashboardMutation,
  useListDeletedDashboardsQuery,
} = browseDashboardsAPI;
