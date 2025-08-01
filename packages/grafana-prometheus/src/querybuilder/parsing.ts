// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/querybuilder/parsing.ts
import { SyntaxNode } from '@lezer/common';
import {
  AggregateExpr,
  AggregateModifier,
  AggregateOp,
  BinaryExpr,
  BoolModifier,
  FunctionCall,
  FunctionCallBody,
  FunctionIdentifier,
  GroupingLabels,
  Identifier,
  LabelName,
  QuotedLabelName,
  MatchingModifierClause,
  MatchOp,
  NumberDurationLiteral,
  On,
  ParenExpr,
  parser,
  StringLiteral,
  QuotedLabelMatcher,
  UnquotedLabelMatcher,
  VectorSelector,
  Without,
} from '@prometheus-io/lezer-promql';

import { t } from '@grafana/i18n';

import { binaryScalarOperatorToOperatorName } from './binaryScalarOperations';
import {
  ErrorId,
  getAllByType,
  getLeftMostChild,
  getString,
  makeBinOp,
  makeError,
  replaceBuiltInVariable,
  replaceVariables,
  returnBuiltInVariable,
} from './parsingUtils';
import { QueryBuilderLabelFilter, QueryBuilderOperation } from './shared/types';
import { PromVisualQuery, PromVisualQueryBinary } from './types';

/**
 * Parses a PromQL query into a visual query model.
 *
 * It traverses the tree and uses sort of state machine to update the query model.
 * The query model is modified during the traversal and sent to each handler as context.
 */
export function buildVisualQueryFromString(expr: string): Omit<Context, 'replacements'> {
  expr = replaceBuiltInVariable(expr);
  const { replacedExpr, replacedVariables } = replaceVariables(expr);
  const tree = parser.parse(replacedExpr);
  const node = tree.topNode;

  // This will be modified in the handlers.
  const visQuery: PromVisualQuery = {
    metric: '',
    labels: [],
    operations: [],
  };
  const context: Context = {
    query: visQuery,
    errors: [],
    replacements: replacedVariables,
  };

  try {
    handleExpression(replacedExpr, node, context);
  } catch (err) {
    // Not ideal to log it here, but otherwise we would lose the stack trace.
    console.error(err);
    if (err instanceof Error) {
      context.errors.push({
        text: err.message,
      });
    }
  }

  // If we have empty query, we want to reset errors
  if (isEmptyQuery(context.query)) {
    context.errors = [];
  }

  // No need to return replaced variables
  delete context.replacements;

  return context;
}

interface ParsingError {
  text: string;
  from?: number;
  to?: number;
  parentType?: string;
}

interface Context {
  query: PromVisualQuery;
  errors: ParsingError[];
  replacements?: Record<string, string>;
}

/**
 * Handler for default state. It will traverse the tree and call the appropriate handler for each node. The node
 * handled here does not necessarily need to be of type == Expr.
 * @param expr
 * @param node
 * @param context
 */
function handleExpression(expr: string, node: SyntaxNode, context: Context) {
  const visQuery = context.query;

  switch (node.type.id) {
    case Identifier: {
      // Expectation is that there is only one of those per query.
      visQuery.metric = getString(expr, node);
      break;
    }

    case QuotedLabelName: {
      // Usually we got the metric name above in the Identifier case.
      // If we didn't get the name that's potentially we have it in curly braces as quoted string.
      // It must be quoted because that's how utf8 metric names should be defined
      // See proposal https://github.com/prometheus/proposals/blob/main/proposals/2023-08-21-utf8.md
      if (visQuery.metric === '') {
        const strLiteral = node.getChild(StringLiteral);
        const quotedMetric = getString(expr, strLiteral);
        visQuery.metric = quotedMetric.slice(1, -1);
      }
      break;
    }

    case QuotedLabelMatcher: {
      const quotedLabel = getLabel(expr, node, QuotedLabelName);
      quotedLabel.label = quotedLabel.label.slice(1, -1);
      visQuery.labels.push(quotedLabel);
      const err = node.getChild(ErrorId);
      if (err) {
        context.errors.push(makeError(expr, err));
      }
      break;
    }

    case UnquotedLabelMatcher: {
      // Same as MetricIdentifier should be just one per query.
      visQuery.labels.push(getLabel(expr, node, LabelName));
      const err = node.getChild(ErrorId);
      if (err) {
        context.errors.push(makeError(expr, err));
      }
      break;
    }

    case FunctionCall: {
      handleFunction(expr, node, context);
      break;
    }

    case AggregateExpr: {
      handleAggregation(expr, node, context);
      break;
    }

    case BinaryExpr: {
      handleBinary(expr, node, context);
      break;
    }

    case ErrorId: {
      if (isIntervalVariableError(node)) {
        break;
      }
      context.errors.push(makeError(expr, node));
      break;
    }

    default: {
      if (node.type.id === ParenExpr) {
        // We don't support parenthesis in the query to group expressions.
        // We just report error but go on with the parsing.
        context.errors.push(makeError(expr, node));
      }
      // Any other nodes we just ignore and go to its children. This should be fine as there are lots of wrapper
      // nodes that can be skipped.
      // TODO: there are probably cases where we will just skip nodes we don't support and we should be able to
      //  detect those and report back.
      let child = node.firstChild;
      while (child) {
        handleExpression(expr, child, context);
        child = child.nextSibling;
      }
    }
  }
}

// TODO check if we still need this
function isIntervalVariableError(node: SyntaxNode) {
  return node.prevSibling?.firstChild?.type.id === VectorSelector;
}

function getLabel(
  expr: string,
  node: SyntaxNode,
  labelType: typeof LabelName | typeof QuotedLabelName
): QueryBuilderLabelFilter {
  const label = getString(expr, node.getChild(labelType));
  const op = getString(expr, node.getChild(MatchOp));
  const value = getString(expr, node.getChild(StringLiteral)).replace(/^["'`]|["'`]$/g, '');
  return {
    label,
    op,
    value,
  };
}

const rangeFunctions = ['changes', 'rate', 'irate', 'increase', 'delta'];

/**
 * Handle function call which is usually and identifier and its body > arguments.
 * @param expr
 * @param node
 * @param context
 */
function handleFunction(expr: string, node: SyntaxNode, context: Context) {
  const visQuery = context.query;
  const nameNode = node.getChild(FunctionIdentifier);
  const funcName = getString(expr, nameNode);

  // Visual query builder doesn't support nested queries and so info function.
  if (funcName === 'info') {
    context.errors.push({
      text: t(
        'grafana-prometheus.querybuilder.handle-function.text.query-parsing-is-ambiguous',
        'Query parsing is ambiguous.'
      ),
      from: node.from,
      to: node.to,
    });
  }

  const body = node.getChild(FunctionCallBody);
  const params = [];
  let interval = '';

  // This is a bit of a shortcut to get the interval argument. Reasons are
  // - interval is not part of the function args per promQL grammar but we model it as argument for the function in
  //   the query model.
  // - it is easier to handle template variables this way as template variable is an error for the parser
  if (rangeFunctions.includes(funcName) || funcName.endsWith('_over_time')) {
    let match = getString(expr, node).match(/\[(.+)\]/);
    if (match?.[1]) {
      interval = match[1];
      // We were replaced the builtin variables to prevent errors
      // Here we return those back
      params.push(returnBuiltInVariable(match[1]));
    }
  }

  const op = { id: funcName, params };
  // We unshift operations to keep the more natural order that we want to have in the visual query editor.
  visQuery.operations.unshift(op);

  if (body) {
    if (getString(expr, body) === '([' + interval + '])') {
      // This is a special case where we have a function with a single argument and it is the interval.
      // This happens when you start adding operations in query builder and did not set a metric yet.
      return;
    }
    updateFunctionArgs(expr, body, context, op);
  }
}

/**
 * Handle aggregation as they are distinct type from other functions.
 * @param expr
 * @param node
 * @param context
 */
function handleAggregation(expr: string, node: SyntaxNode, context: Context) {
  const visQuery = context.query;
  const nameNode = node.getChild(AggregateOp);
  let funcName = getString(expr, nameNode);

  const modifier = node.getChild(AggregateModifier);
  const labels = [];

  if (modifier) {
    const byModifier = modifier.getChild(`By`);
    if (byModifier && funcName) {
      funcName = `__${funcName}_by`;
    }

    const withoutModifier = modifier.getChild(Without);
    if (withoutModifier) {
      funcName = `__${funcName}_without`;
    }

    labels.push(...getAllByType(expr, modifier, LabelName), ...getAllByType(expr, modifier, QuotedLabelName));
  }

  const body = node.getChild(FunctionCallBody);

  const op: QueryBuilderOperation = { id: funcName, params: [] };
  visQuery.operations.unshift(op);
  updateFunctionArgs(expr, body, context, op);
  // We add labels after params in the visual query editor.
  op.params.push(...labels);
}

/**
 * Handle (probably) all types of arguments that function or aggregation can have.
 *
 * We cannot just get all the children and iterate them as arguments we have to again recursively traverse through
 *  them.
 *
 * @param expr
 * @param node
 * @param context
 * @param op - We need the operation to add the params to as an additional context.
 */
function updateFunctionArgs(expr: string, node: SyntaxNode | null, context: Context, op: QueryBuilderOperation) {
  if (!node) {
    return;
  }
  switch (node.type.id) {
    case FunctionCallBody: {
      let child = node.firstChild;

      while (child) {
        let binaryExpressionWithinFunctionArgs: SyntaxNode | null;
        if (child.type.id === BinaryExpr) {
          binaryExpressionWithinFunctionArgs = child;
        } else {
          binaryExpressionWithinFunctionArgs = child.getChild(BinaryExpr);
        }

        if (binaryExpressionWithinFunctionArgs) {
          context.errors.push({
            text: t(
              'grafana-prometheus.querybuilder.update-function-args.text.query-parsing-is-ambiguous',
              'Query parsing is ambiguous.'
            ),
            from: binaryExpressionWithinFunctionArgs.from,
            to: binaryExpressionWithinFunctionArgs.to,
          });
        }

        updateFunctionArgs(expr, child, context, op);
        child = child.nextSibling;
      }
      break;
    }

    case NumberDurationLiteral: {
      op.params.push(parseFloat(getString(expr, node)));
      break;
    }

    case StringLiteral: {
      op.params.push(getString(expr, node).replace(/"/g, ''));
      break;
    }

    case VectorSelector: {
      // When we replace a custom variable to prevent errors during parsing we receive VectorSelector and Identifier in it.
      // But this is also a normal case for a normal function body. i.e. topk(5, http_requests_total{})
      // In such cases we got identifier as http_requests_total. So we shouldn't push this as param.
      // So we check whether the given VectorSelector is something we replaced earlier.
      if (context.replacements?.[expr.substring(node.from, node.to)]) {
        const identifierNode = node.getChild(Identifier);
        const customVarName = getString(expr, identifierNode);
        op.params.push(customVarName);
        break;
      }
    }

    default: {
      // Means we get to something that does not seem like simple function arg and is probably nested query so jump
      // back to main context
      handleExpression(expr, node, context);
    }
  }
}

/**
 * Right now binary expressions can be represented in 2 way in visual query. As additional operation in case it is
 * just operation with scalar or it creates a binaryQuery when it's 2 queries.
 * @param expr
 * @param node
 * @param context
 */
function handleBinary(expr: string, node: SyntaxNode, context: Context) {
  const visQuery = context.query;
  const left = node.firstChild!;
  const op = getString(expr, left.nextSibling);
  const binModifier = getBinaryModifier(expr, node.getChild(BoolModifier) ?? node.getChild(MatchingModifierClause));

  const right = node.lastChild!;

  const opDef = binaryScalarOperatorToOperatorName[op];

  const leftNumber = left.type.id === NumberDurationLiteral;
  const rightNumber = right.type.id === NumberDurationLiteral;

  const rightBinary = right.type.id === BinaryExpr;

  if (leftNumber) {
    // TODO: this should be already handled in case parent is binary expression as it has to be added to parent
    //  if query starts with a number that isn't handled now.
  } else {
    // If this is binary we don't really know if there is a query or just chained scalars. So
    // we have to traverse a bit deeper to know
    handleExpression(expr, left, context);
  }

  if (rightNumber) {
    visQuery.operations.push(makeBinOp(opDef, expr, right, !!binModifier?.isBool));
  } else if (rightBinary) {
    // Due to the way binary ops are parsed we can get a binary operation on the right that starts with a number which
    // is a factor for a current binary operation. So we have to add it as an operation now.
    const leftMostChild = getLeftMostChild(right);
    if (leftMostChild?.type.id === NumberDurationLiteral) {
      visQuery.operations.push(makeBinOp(opDef, expr, leftMostChild, !!binModifier?.isBool));
    }

    // If we added the first number literal as operation here we still can continue and handle the rest as the first
    // number will be just skipped.
    handleExpression(expr, right, context);
  } else {
    visQuery.binaryQueries = visQuery.binaryQueries || [];
    const binQuery: PromVisualQueryBinary = {
      operator: op,
      query: {
        metric: '',
        labels: [],
        operations: [],
      },
    };
    if (binModifier?.isMatcher) {
      binQuery.vectorMatchesType = binModifier.matchType;
      binQuery.vectorMatches = binModifier.matches;
    }
    visQuery.binaryQueries.push(binQuery);
    handleExpression(expr, right, {
      query: binQuery.query,
      errors: context.errors,
      replacements: context.replacements,
    });
  }
}

// TODO revisit this function.
function getBinaryModifier(
  expr: string,
  node: SyntaxNode | null
):
  | { isBool: true; isMatcher: false }
  | { isBool: false; isMatcher: true; matches: string; matchType: 'ignoring' | 'on' }
  | undefined {
  if (!node) {
    return undefined;
  }
  if (node.getChild('Bool')) {
    return { isBool: true, isMatcher: false };
  } else {
    let labels = '';
    const groupingLabels = node.getChild(GroupingLabels);
    if (groupingLabels) {
      labels = getAllByType(expr, groupingLabels, LabelName).join(', ');
    }

    return {
      isMatcher: true,
      isBool: false,
      matches: labels,
      matchType: node.getChild(On) ? 'on' : 'ignoring',
    };
  }
}

function isEmptyQuery(query: PromVisualQuery) {
  if (query.labels.length === 0 && query.operations.length === 0 && !query.metric) {
    return true;
  }
  return false;
}
