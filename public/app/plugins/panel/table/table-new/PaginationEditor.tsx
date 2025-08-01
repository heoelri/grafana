import * as React from 'react';

import { StandardEditorProps } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { Switch } from '@grafana/ui';

export function PaginationEditor({ onChange, value }: StandardEditorProps<boolean>) {
  const changeValue = (event: React.FormEvent<HTMLInputElement> | undefined) => {
    onChange(event?.currentTarget.checked);
  };

  return (
    <Switch
      label={selectors.components.PanelEditor.OptionsPane.fieldLabel(`Enable pagination`)}
      value={Boolean(value)}
      onChange={changeValue}
    />
  );
}
