/* React remount guards — typing in a field must never lose focus.
 *
 * React keeps a DOM node (and its focus) only while the element type and key
 * at that tree position stay the same. Two easy ways to break that:
 *
 * helix-web/no-nested-components
 *   A PascalCase function component declared inside another function and
 *   rendered as `<Inner />` from that scope. Every render of the outer
 *   function creates a new component type, so React unmounts and remounts the
 *   whole `<Inner />` subtree (inputs lose focus and local state). Hoist the
 *   component to module scope and pass props, or call it as a plain function
 *   (`{renderInner()}`) so it contributes elements rather than a type.
 *
 * helix-web/no-editable-key
 *   Heuristic for list keys derived from a value the row itself edits. Inside a
 *   `.map(...)`/`.flatMap(...)` callback whose first parameter is `item` (or a
 *   destructured `{ prop }`), the rule collects every `item.<prop>` read by a
 *   `key={...}` that belongs to the callback. It then scans the callback's
 *   `onChange`, `onInput`, `onValueChange`, and `onCheckedChange` handler
 *   expressions for a write to the same `<prop>`:
 *     - an object-literal property `{ prop: ... }` (not `{ prop: item.prop }`,
 *       which only forwards identity),
 *     - an assignment `x.prop = ...`,
 *     - a string-literal argument `update(index, "prop", value)`.
 *   Any match means a keystroke changes the key, which remounts the row. Give
 *   the row a stable client id (`rowKey`) created with the row instead.
 *   Handlers passed by reference (`onChange={handleChange}`) are not followed,
 *   which keeps false positives low at the cost of missing some cases. */

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/u;
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);
const EDIT_HANDLERS = new Set(["onChange", "onInput", "onValueChange", "onCheckedChange"]);
const VISITOR_SKIP = new Set(["parent", "loc", "range", "tokens", "comments"]);

function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (VISITOR_SKIP.has(key)) continue;
    if (Array.isArray(value)) {
      for (const entry of value) if (entry && typeof entry.type === "string") out.push(entry);
    } else if (value && typeof value.type === "string") {
      out.push(value);
    }
  }
  return out;
}

/** Depth-first walk; `visit` returning false skips that node's children. */
function walk(node, visit) {
  if (visit(node) === false) return;
  for (const child of children(node)) walk(child, visit);
}

function containsJsx(node) {
  let found = false;
  walk(node, (child) => {
    if (found) return false;
    if (child.type === "JSXElement" || child.type === "JSXFragment") found = true;
    return !found;
  });
  return found;
}

function wrapperName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) return callee.property.name;
  return null;
}

/** The function node that defines a component variable, if any. */
function componentFunction(definition) {
  const node = definition.node;
  if (node.type === "FunctionDeclaration") return node;
  if (node.type !== "VariableDeclarator" || !node.init) return null;
  let init = node.init;
  while (
    init.type === "CallExpression" &&
    COMPONENT_WRAPPERS.has(wrapperName(init.callee)) &&
    init.arguments[0]
  ) {
    init = init.arguments[0];
  }
  return FUNCTION_TYPES.has(init.type) ? init : null;
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTION_TYPES.has(current.type)) return current;
  }
  return null;
}

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return null;
}

const noNestedComponentsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow rendering components declared inside another function; each render creates a new type and remounts the subtree.",
    },
    messages: {
      nested:
        "<{{name}} /> is declared inside another function, so every render creates a new component type and remounts it (inputs lose focus). Hoist it to module scope and pass props, or call it as a function.",
    },
    schema: [],
  },
  create(context) {
    const reported = new Set();
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !PASCAL_CASE.test(node.name.name)) return;
        const variable = findVariable(context.sourceCode.getScope(node), node.name.name);
        if (!variable || reported.has(variable)) return;
        const definition = variable.defs[0];
        if (!definition) return;
        const component = componentFunction(definition);
        if (!component) return;
        // Module-scope components are fine; only nested declarations remount.
        if (!enclosingFunction(definition.node)) return;
        if (!containsJsx(component)) return;
        reported.add(variable);
        context.report({ node, messageId: "nested", data: { name: node.name.name } });
      },
    };
  },
};

/** Map local identifier → item property for the `.map` callback's first param. */
function itemBindings(param) {
  if (!param) return null;
  if (param.type === "Identifier") return { object: param.name, props: new Map() };
  if (param.type !== "ObjectPattern") return null;
  const props = new Map();
  for (const property of param.properties) {
    if (property.type !== "Property" || property.computed) continue;
    const key = property.key.type === "Identifier" ? property.key.name : null;
    const value =
      property.value.type === "AssignmentPattern" ? property.value.left : property.value;
    if (key && value.type === "Identifier") props.set(value.name, key);
  }
  return { object: null, props };
}

function memberProp(node, object) {
  if (
    object &&
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === object &&
    node.property.type === "Identifier"
  ) {
    return node.property.name;
  }
  return null;
}

/** Item properties a key expression reads. */
function keyProps(expression, bindings) {
  const props = new Set();
  walk(expression, (node) => {
    const prop = memberProp(node, bindings.object);
    if (prop) {
      props.add(prop);
      return false;
    }
    if (node.type === "Identifier" && bindings.props.has(node.name)) {
      props.add(bindings.props.get(node.name));
    }
    return undefined;
  });
  return props;
}

function propertyKeyName(property) {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }
  return null;
}

/** True when `{ prop: item.prop }` / `{ prop }` only forwards the current value. */
function forwardsIdentity(property, prop, bindings) {
  const value = property.value;
  if (memberProp(value, bindings.object) === prop) return true;
  return value.type === "Identifier" && bindings.props.get(value.name) === prop;
}

/** Item properties an edit handler writes. */
function writtenProps(handler, bindings) {
  const props = new Set();
  walk(handler, (node) => {
    if (node.type === "Property") {
      const name = propertyKeyName(node);
      if (name && !forwardsIdentity(node, name, bindings)) props.add(name);
    } else if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      !node.left.computed &&
      node.left.property.type === "Identifier"
    ) {
      props.add(node.left.property.name);
    } else if (node.type === "CallExpression") {
      for (const argument of node.arguments) {
        if (argument.type === "Literal" && typeof argument.value === "string") {
          props.add(argument.value);
        }
      }
    }
    return undefined;
  });
  return props;
}

function isMapCallback(node) {
  const call = node.parent;
  return (
    call?.type === "CallExpression" &&
    call.arguments[0] === node &&
    call.callee.type === "MemberExpression" &&
    !call.callee.computed &&
    (call.callee.property.name === "map" || call.callee.property.name === "flatMap")
  );
}

const noEditableKeyRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow list keys derived from a value the row edits; each keystroke would remount the row.",
    },
    messages: {
      editableKey:
        "key reads `{{prop}}`, which this row's change handler edits, so every keystroke remounts the row and drops focus. Key the row by a stable id (e.g. a client `rowKey` created with the row).",
    },
    schema: [],
  },
  create(context) {
    function check(callback) {
      if (!isMapCallback(callback)) return;
      const bindings = itemBindings(callback.params[0]);
      if (!bindings) return;
      const keys = [];
      const handlers = [];
      walk(callback.body, (node) => {
        if (node.type !== "JSXAttribute" || node.name.type !== "JSXIdentifier") return undefined;
        const value = node.value?.type === "JSXExpressionContainer" ? node.value.expression : null;
        if (!value) return undefined;
        if (node.name.name === "key" && enclosingFunction(node) === callback) keys.push(value);
        if (EDIT_HANDLERS.has(node.name.name)) handlers.push(value);
        return undefined;
      });
      if (keys.length === 0 || handlers.length === 0) return;
      const written = new Set();
      for (const handler of handlers) {
        for (const prop of writtenProps(handler, bindings)) written.add(prop);
      }
      for (const key of keys) {
        for (const prop of keyProps(key, bindings)) {
          if (written.has(prop)) {
            context.report({ node: key, messageId: "editableKey", data: { prop } });
            break;
          }
        }
      }
    }
    return { ArrowFunctionExpression: check, FunctionExpression: check };
  },
};

export const remountRules = {
  "no-nested-components": noNestedComponentsRule,
  "no-editable-key": noEditableKeyRule,
};
