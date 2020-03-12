// A simple SHACL validator in JavaScript based on SHACL-JS.

// Design:
//
// First, derive a ShapesGraph object from the definitions in $shapes.
// This manages a map of parameters to ConstraintComponents.
// Each ConstraintComponent manages its list of parameters and a link to the validators.
//
// The ShapesGraph also manages a list of Shapes, each which has a list of Constraints.
// A Constraint is a specific combination of parameters for a constraint component,
// and has functions to access the target nodes.
//
// Each ShapesGraph can be reused between validation calls, and thus often only needs
// to be created once per application.
//
// The validation process is started by creating a ValidationEngine that relies on
// a given ShapesGraph and operates on the current $data().
// It basically walks through all Shapes that have target nodes and runs the validators
// for each Constraint of the shape, producing results along the way.

const RDFQuery = require('./rdfquery')
const RDFQueryUtil = require('./rdfquery/util')
const NodeSet = require('./node-set')
const ValidationFunction = require('./validation-function')
const validatorsRegistry = require('./validators-registry')
const { rdfs, sh } = require('./namespaces')

class ShapesGraph {
  constructor (context) {
    this.context = context

    // Collect all defined constraint components
    const componentNodes = new RDFQueryUtil(context.$shapes).getInstancesOf(sh.ConstraintComponent)
    this.components = [...componentNodes].map((node) => new ConstraintComponent(node, context))

    // Build map from parameters to constraint components
    this.parametersMap = {}
    for (let i = 0; i < this.components.length; i++) {
      const component = this.components[i]
      const parameters = component.getParameters()
      for (let j = 0; j < parameters.length; j++) {
        this.parametersMap[parameters[j].value] = component
      }
    }

    // Collection of shapes is populated on demand - here we remember the instances
    this.shapes = {} // Keys are the URIs/bnode ids of the shape nodes
  }

  getComponentWithParameter (parameter) {
    return this.parametersMap[parameter.value]
  }

  getShape (shapeNode) {
    let shape = this.shapes[shapeNode.value]
    if (!shape) {
      shape = new Shape(this.context, shapeNode)
      this.shapes[shapeNode.value] = shape
    }
    return shape
  }

  getShapeNodesWithConstraints () {
    if (!this.shapeNodesWithConstraints) {
      const set = new NodeSet()
      for (let i = 0; i < this.components.length; i++) {
        const params = this.components[i].requiredParameters
        for (let j = 0; j < params.length; j++) {
          this.context.$shapes.query().match('?shape', params[j], null).addAllNodes('?shape', set)
        }
      }
      this.shapeNodesWithConstraints = [...set]
    }
    return this.shapeNodesWithConstraints
  }

  getShapesWithTarget () {
    const $shapes = this.context.$shapes

    if (!this.targetShapes) {
      this.targetShapes = []
      const cs = this.getShapeNodesWithConstraints()
      for (let i = 0; i < cs.length; i++) {
        const shapeNode = cs[i]
        if (
          new RDFQueryUtil($shapes).isInstanceOf(shapeNode, rdfs.Class) ||
          $shapes.query().match(shapeNode, 'sh:targetClass', null).hasSolution() ||
          $shapes.query().match(shapeNode, 'sh:targetNode', null).hasSolution() ||
          $shapes.query().match(shapeNode, 'sh:targetSubjectsOf', null).hasSolution() ||
          $shapes.query().match(shapeNode, 'sh:targetObjectsOf', null).hasSolution() ||
          $shapes.query().match(shapeNode, 'sh:target', null).hasSolution()
        ) {
          this.targetShapes.push(this.getShape(shapeNode))
        }
      }
    }

    return this.targetShapes
  }
}

class Constraint {
  constructor (shape, component, paramValue, rdfShapesGraph) {
    this.shape = shape
    this.component = component
    this.paramValue = paramValue
    const parameterValues = {}
    const params = component.getParameters()
    for (let i = 0; i < params.length; i++) {
      const param = params[i]
      const value = paramValue || rdfShapesGraph.query().match(shape.shapeNode, param, '?value').getNode('?value')
      if (value) {
        const localName = RDFQuery.getLocalName(param.value)
        parameterValues[localName] = value
      }
    }
    this.parameterValues = parameterValues
  }

  getParameterValue (paramName) {
    return this.parameterValues[paramName]
  }

  get componentMessages () {
    return this.component.getMessages(this.shape)
  }
}

class ConstraintComponent {
  constructor (node, context) {
    this.context = context
    this.node = node
    const parameters = []
    const parameterNodes = []
    const requiredParameters = []
    const optionals = {}
    const that = this
    this.context.$shapes.query()
      .match(node, 'sh:parameter', '?parameter')
      .match('?parameter', 'sh:path', '?path').forEach(function (sol) {
        parameters.push(sol.path)
        parameterNodes.push(sol.parameter)
        if (that.context.$shapes.query().match(sol.parameter, 'sh:optional', 'true').hasSolution()) {
          optionals[sol.path.value] = true
        } else {
          requiredParameters.push(sol.path)
        }
      })
    this.optionals = optionals
    this.parameters = parameters
    this.parameterNodes = parameterNodes
    this.requiredParameters = requiredParameters

    this.nodeValidationFunction = this.findValidationFunction(sh.nodeValidator)
    if (!this.nodeValidationFunction) {
      this.nodeValidationFunction = this.findValidationFunction(sh.validator)
      this.nodeValidationFunctionGeneric = true
    }
    this.propertyValidationFunction = this.findValidationFunction(sh.propertyValidator)
    if (!this.propertyValidationFunction) {
      this.propertyValidationFunction = this.findValidationFunction(sh.validator)
      this.propertyValidationFunctionGeneric = true
    }
  }

  findValidationFunction (predicate) {
    const validatorType = predicate.value.split('#').slice(-1)[0]
    const validator = this.findValidator(validatorType)

    if (!validator) return null

    return new ValidationFunction(this.context, validator.func.name, this.parameters, validator.func)
  }

  getMessages (shape) {
    const generic = shape.isPropertyShape() ? this.propertyValidationFunctionGeneric : this.nodeValidationFunctionGeneric
    const validatorType = generic ? 'validator' : (shape.isPropertyShape() ? 'propertyValidator' : 'nodeValidator')
    const validator = this.findValidator(validatorType)

    if (!validator) return []

    const message = validator.message

    return message ? [message] : []
  }

  findValidator (validatorType) {
    const constraintValidators = validatorsRegistry[this.node.value]

    if (!constraintValidators) return null

    const validator = constraintValidators[validatorType]

    return validator || null
  }

  getParameters () {
    return this.parameters
  }

  isComplete (shapeNode) {
    for (let i = 0; i < this.parameters.length; i++) {
      const parameter = this.parameters[i]
      if (!this.isOptional(parameter.value)) {
        if (!this.context.$shapes.query().match(shapeNode, parameter, null).hasSolution()) {
          return false
        }
      }
    }
    return true
  }

  isOptional (parameterURI) {
    return this.optionals[parameterURI]
  }
}

class Shape {
  constructor (context, shapeNode) {
    this.context = context
    this.severity = context.$shapes.query().match(shapeNode, 'sh:severity', '?severity').getNode('?severity')
    if (!this.severity) {
      this.severity = context.factory.term('sh:Violation')
    }

    this.deactivated = context.$shapes.query().match(shapeNode, 'sh:deactivated', 'true').hasSolution()
    this.path = context.$shapes.query().match(shapeNode, 'sh:path', '?path').getNode('?path')
    this.shapeNode = shapeNode
    this.constraints = []

    const handled = new NodeSet()
    const self = this
    const that = this
    context.$shapes.query().match(shapeNode, '?predicate', '?object').forEach(function (sol) {
      const component = that.context.shapesGraph.getComponentWithParameter(sol.predicate)
      if (component && !handled.has(component.node)) {
        const params = component.getParameters()
        if (params.length === 1) {
          self.constraints.push(new Constraint(self, component, sol.object, context.$shapes))
        } else if (component.isComplete(shapeNode)) {
          self.constraints.push(new Constraint(self, component, undefined, context.$shapes))
          handled.add(component.node)
        }
      }
    })
  }

  getConstraints () {
    return this.constraints
  }

  getTargetNodes (rdfDataGraph) {
    const results = new NodeSet()

    if (new RDFQueryUtil(this.context.$shapes).isInstanceOf(this.shapeNode, rdfs.Class)) {
      results.addAll(new RDFQueryUtil(rdfDataGraph).getInstancesOf(this.shapeNode))
    }

    this.context.$shapes.query()
      .match(this.shapeNode, 'sh:targetClass', '?targetClass').forEachNode('?targetClass', (targetClass) => {
        results.addAll(new RDFQueryUtil(rdfDataGraph).getInstancesOf(targetClass))
      })

    results.addAll(this.context.$shapes.query()
      .match(this.shapeNode, 'sh:targetNode', '?targetNode').getNodeArray('?targetNode'))

    this.context.$shapes.query()
      .match(this.shapeNode, 'sh:targetSubjectsOf', '?subjectsOf')
      .forEachNode('?subjectsOf', (predicate) => {
        results.addAll(rdfDataGraph.query().match('?subject', predicate, null).getNodeArray('?subject'))
      })

    this.context.$shapes.query()
      .match(this.shapeNode, 'sh:targetObjectsOf', '?objectsOf')
      .forEachNode('?objectsOf', (predicate) => {
        results.addAll(rdfDataGraph.query().match(null, predicate, '?object').getNodeArray('?object'))
      })

    return [...results]
  }

  getValueNodes (focusNode, rdfDataGraph) {
    if (this.path) {
      return rdfDataGraph.query().path(focusNode, toRDFQueryPath(this.context.$shapes, this.path), '?object').getNodeArray('?object')
    } else {
      return [focusNode]
    }
  }

  isPropertyShape () {
    return this.path != null
  }
}

function toRDFQueryPath ($shapes, shPath) {
  if (shPath.termType === 'Collection') {
    const paths = new RDFQueryUtil($shapes).rdfListToArray(shPath)
    const result = []
    for (let i = 0; i < paths.length; i++) {
      result.push(toRDFQueryPath($shapes, paths[i]))
    }
    return result
  }

  if (shPath.termType === 'NamedNode') {
    return shPath
  }

  if (shPath.termType === 'BlankNode') {
    const util = new RDFQueryUtil($shapes)

    if (util.getObject(shPath, 'rdf:first')) {
      const paths = util.rdfListToArray(shPath)
      const result = []
      for (let i = 0; i < paths.length; i++) {
        result.push(toRDFQueryPath($shapes, paths[i]))
      }
      return result
    }

    const alternativePath = new RDFQuery($shapes).getObject(shPath, 'sh:alternativePath')
    if (alternativePath) {
      const paths = util.rdfListToArray(alternativePath)
      const result = []
      for (let i = 0; i < paths.length; i++) {
        result.push(toRDFQueryPath($shapes, paths[i]))
      }
      return { or: result }
    }

    const zeroOrMorePath = util.getObject(shPath, 'sh:zeroOrMorePath')
    if (zeroOrMorePath) {
      return { zeroOrMore: toRDFQueryPath($shapes, zeroOrMorePath) }
    }

    const oneOrMorePath = util.getObject(shPath, 'sh:oneOrMorePath')
    if (oneOrMorePath) {
      return { oneOrMore: toRDFQueryPath($shapes, oneOrMorePath) }
    }

    const zeroOrOnePath = util.getObject(shPath, 'sh:zeroOrOnePath')
    if (zeroOrOnePath) {
      return { zeroOrOne: toRDFQueryPath($shapes, zeroOrOnePath) }
    }

    const inversePath = util.getObject(shPath, 'sh:inversePath')
    if (inversePath) {
      return { inverse: toRDFQueryPath($shapes, inversePath) }
    }
  }

  throw new Error('Unsupported SHACL path ' + shPath)
  // TODO: implement conforming to AbstractQuery.path syntax
  // return shPath
}

module.exports = ShapesGraph
