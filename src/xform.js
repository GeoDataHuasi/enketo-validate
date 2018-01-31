'use strict';

const jsdom = require( 'jsdom' );
const { JSDOM } = jsdom;
const fs = require( 'fs' );
const path = require( 'path' );
const libxslt = require( 'libxslt' );
const libxmljs = libxslt.libxmljs;
const sheets = require( 'enketo-xslt' );
const xslModelSheet = libxslt.parse( sheets.xslModel );

class XForm {

    constructor( xformStr, options = {} ) {
        this.options = options;
        if ( !xformStr || !xformStr.trim() ) {
            throw 'Empty form.';
        }
        this.xformStr = xformStr;
        this.dom = this._getDom();
        this.doc = this.dom.window.document;
    }

    get binds() {
        this._binds = this._binds || [ ...this.doc.querySelectorAll( 'bind' ) ];
        return this._binds;
    }

    get bindsWithCalc() {
        this._bindsWithCalc = this._bindsWithCalc || [ ...this.doc.querySelectorAll( 'bind[calculate]' ) ];
        return this._bindsWithCalc;
    }

    // The reason this is not included in the constructor is to separate different types of errors,
    // and keep the constructor just for XML parse errors.
    parseModel() {
        // Be careful here, the pkg module to create binaries is surprisingly sophisticated, but the paths cannot be dynamic.
        const scriptContent = this.options.openclinica ?
            fs.readFileSync( path.join( __dirname, '../build/FormModel-bundle-oc.js' ), { encoding: 'utf-8' } ) :
            fs.readFileSync( path.join( __dirname, '../build/FormModel-bundle.js' ), { encoding: 'utf-8' } );

        // This window is not to be confused with this.dom.window which contains the XForm.
        const window = this._getWindow( scriptContent );

        // Disable the jsdom evaluator
        window.document.evaluate = undefined;

        // Get a serialized model with namespaces in locations that Enketo can deal with.
        const modelStr = this._extractModelStr().root().get( '*' ).toString( false );
        const external = this._getExternalDummyContent();

        // Instantiate an Enketo Core Form Model
        this.model = new window.FormModel( { modelStr: modelStr, external: external } );
        let loadErrors = this.model.init();

        if ( loadErrors.length ) {
            throw loadErrors;
        }
    }

    enketoEvaluate( expr, type = 'string', contextPath = null ) {
        try {
            if ( !this.model ) {
                console.log( 'Unexpectedly, there is no model when enketoEvaluate is called, creating one.' );
                this.parseModel();
            }
            // Note that the jsdom XPath evaluator was disabled in parseModel.
            // So we are certain to be testing Enketo's own XPath evaluator.
            let newExpr = this._stripJrChoiceName( expr );
            return this.model.evaluate( newExpr, type, contextPath );
        } catch ( e ) {
            throw this._cleanXPathException( e );
        }
    }

    checkStructure( warnings, errors ) {
        const htmlNamespace = 'http://www.w3.org/1999/xhtml';
        const xformsNamespace = 'http://www.w3.org/2002/xforms';

        const rootEl = this.doc.documentElement;
        const rootElNodeName = rootEl.nodeName;
        if ( !( /^[A-z]+:html$/.test( rootElNodeName ) ) ) {
            errors.push( 'Root element should be <html>.' );
        }
        if ( rootEl.namespaceURI !== htmlNamespace ) {
            errors.push( 'Root element has incorrect namespace.' );
        }

        let headEl;
        let bodyEl;
        for ( let el of rootEl.children ) {
            if ( /^[A-z]+:head$/.test( el.nodeName ) ) {
                headEl = el;
            } else if ( /^[A-z]+:body$/.test( el.nodeName ) ) {
                bodyEl = el;
            }
        }
        if ( !headEl ) {
            errors.push( 'No head element found as child of <html>.' );
        }
        if ( headEl && headEl.namespaceURI !== htmlNamespace ) {
            errors.push( 'Head element has incorrect namespace.' );
        }
        if ( !bodyEl ) {
            errors.push( 'No body element found as child of <html>.' );
        }
        if ( bodyEl && bodyEl.namespaceURI !== htmlNamespace ) {
            errors.push( 'Body element has incorrect namespace.' );
        }

        let modelEl;
        if ( headEl ) {
            for ( let el of headEl.children ) {
                if ( /^([A-z]+:)?model$/.test( el.nodeName ) ) {
                    modelEl = el;
                    break;
                }
            }
            if ( !modelEl ) {
                errors.push( 'No model element found as child of <head>.' );
            }
            if ( modelEl && modelEl.namespaceURI !== xformsNamespace ) {
                errors.push( 'Model element has incorrect namespace.' );
            }
        }

        let primInstanceEl;
        if ( modelEl ) {
            for ( let el of modelEl.children ) {
                if ( /^([A-z]+:)?instance$/.test( el.nodeName ) ) {
                    primInstanceEl = el;
                    break;
                }
            }
            if ( !primInstanceEl ) {
                errors.push( 'No primary instance element found as first instance child of <model>.' );
            }
            if ( primInstanceEl && primInstanceEl.namespaceURI !== xformsNamespace ) {
                errors.push( 'Primary instance element has incorrect namespace.' );
            }
        }

        if ( primInstanceEl ) {
            const children = primInstanceEl.children;
            if ( children.length === 0 ) {
                errors.push( 'Primary instance element has child.' );
            } else if ( children.length > 1 ) {
                errors.push( 'Primary instance element has more than 1 child.' );
            }
            if ( children && !children[ 0 ].id ) {
                errors.push( `Data root node <${children[0].nodeName}> has no id attribute.` );
            }
        }

        // ODK Build bug
        if ( this.doc.querySelector( 'group:not([ref])' ) ) {
            warnings.push( 'Found <group> without ref attribute. This might be fine as long as the group has no relevant logic.' );
        }

        // ODK Build output
        if ( this.doc.querySelector( 'group:not([ref]) > repeat' ) ) {
            warnings.push( 'Found <repeat> that has a parent <group> without a ref attribute. ' +
                'If the repeat has relevant logic, this will make the form very slow.' );
        }
    }

    checkRules( warnings, errors ) {
        // Check for use of form controls with calculations that are not readonly
        this.bindsWithCalc
            .filter( this._withFormControl.bind( this ) )
            .filter( bind => {
                const readonly = bind.getAttribute( 'readonly' );
                // TODO: the check for true() should be probably be done in XPath,
                // using XPath boolean conversion rules.
                return !readonly || readonly.trim() !== 'true()';
            } )
            .map( this._nodeNames.bind( this ) )
            .forEach( nodeName => errors.push( `Question "${nodeName}" has a calculation that is not set to readonly.` ) );
    }

    checkOpenClinicaRules( warnings, errors ) {
        const OC_NS = 'http://openclinica.org/xforms';
        const CLINICALDATA_REF = /instance\(\s*(["'])((?:(?!\1)clinicaldata))\1\s*\)/;

        // Check for use of external data in instance "clinicaldata"
        this.bindsWithCalc
            .filter( this._withoutFormControl.bind( this ) )
            .filter( bind => {
                // If both are true we have found an error (in an efficient manner)
                return CLINICALDATA_REF.test( bind.getAttribute( 'calculate' ) ) &&
                    bind.getAttributeNS( OC_NS, 'external' ) !== 'clinicaldata';
            } )
            .map( this._nodeNames.bind( this ) )
            .forEach( nodeName => errors.push( `Found calculation for "${nodeName}" that refers to ` +
                'external clinicaldata without the required "external" attribute in the correct namespace.' ) );
    }

    /*
     * Obtain an isolated "browser" window context and optionally, run a script in this context.
     */
    _getWindow( scriptContent = '' ) {
        // Let any logging by Enketo Core fall into the abyss.
        const virtualConsole = new jsdom.VirtualConsole();
        const { window } = new JSDOM( '', { runScripts: 'dangerously', virtualConsole: virtualConsole } );
        const scriptEl = window.document.createElement( 'script' );
        scriptEl.textContent = scriptContent;
        window.document.body.appendChild( scriptEl );
        return window;
    }

    _getExternalDummyContent() {
        let external = [];
        this.doc.querySelectorAll( 'instance[id][src]' ).forEach( instance => {
            external.push( { id: instance.id, xmlStr: '<something/>' } );
        } );
        return external;
    }

    /*
     * Since this is such a weird function that queries the body of the XForm,
     * and cannot be evaluated in XPath, and I hate it, we just strip it out.
     */
    _stripJrChoiceName( expr ) {
        return expr.replace( /jr:choice-name\(.*\)/g, '"a"' );
    }

    /*
     * This discombulated heavy-handed method ensures that the namespaces are included in their expected locations,
     * at least where Enketo Core knows how to handle them.
     */
    _extractModelStr() {
        let doc = libxmljs.parseXml( this.xformStr );
        return xslModelSheet.apply( doc );
    }

    _getDom() {
        try {
            return new JSDOM( this.xformStr, {
                contentType: 'text/xml'
            } );
        } catch ( e ) {
            throw this._cleanXmlDomParserError( e );
        }
    }

    /**
     * Determines whether bind element has corresponding input form control.
     * 
     * @param {Element} bind The XForm <bind> element
     * @returns {boolean}
     * @memberof XForm
     */
    _withFormControl( bind ) {
        const nodeset = bind.getAttribute( 'nodeset' );
        // We are not checking for <group> and <repeat>,
        // as the purpose of this function is to identify calculations without form control
        return !!this.doc.querySelector( `input[ref="${nodeset}"], select[ref="${nodeset}"], ` +
            `select1[ref="${nodeset}"], trigger[ref="${nodeset}"]` );
    }

    _withoutFormControl( bind ) {
        return !this._withFormControl( bind );
    }

    _nodeNames( bind ) {
        const path = bind.getAttribute( 'nodeset' );
        return path.substring( path.lastIndexOf( '/' ) + 1 );
    }

    _cleanXmlDomParserError( error ) {
        console.log( 'this.options', this.options );
        if ( this.options.debug ) {
            return error;
        }
        let parts = error.message.split( '\n' );
        return parts[ 0 ] + ' ' + parts.splice( 1, 4 ).join( ', ' );
    }

    _cleanXPathException( error ) {
        if ( this.options.debug ) {
            return error;
        }
        let parts = [ error.message.split( '\n' )[ 0 ], error.name, error.code ]
            .filter( part => !!part );

        parts[ 0 ] = parts[ 0 ]
            .replace( /Function "{}(.*)"/g, 'Function "$1"' )
            .replace( /\/model\/instance\[1\]/g, '' )
            .replace( /\(line: undefined, character: undefined\)/g, '' );
        // '. ,' => ','
        return parts.join( ', ' ).replace( /\.\s*,/g, ',' );
    }

}

module.exports = {
    XForm: XForm
};