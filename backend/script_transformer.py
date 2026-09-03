import ast
import json
import logging
from typing import Optional, Dict

logger = logging.getLogger(__name__)

class ScriptRewriter(ast.NodeTransformer):
    """
    Dynamically rewrites the generated script.py to inject user inputs,
    preserve sessions, and map file uploads.
    """
    def __init__(self, query: str, session_id: Optional[str] = None, files: Optional[Dict[str, str]] = None):
        self.query = query
        self.session_id = session_id
        self.files = files or {}
        
        # Tracking what we replaced
        self.replaced_inputs = False
        self.bypassed_session_creation = False

    def visit_Assign(self, node: ast.Assign) -> ast.AST:
        # Check if this is `inputs = {...}`
        if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "inputs":
            if isinstance(node.value, ast.Dict):
                # Try to find the main query field
                # Priority: "query", "question", "prompt", "text", or the first string with "<value>"
                best_idx = -1
                for idx, key in enumerate(node.value.keys):
                    if isinstance(key, ast.Constant):
                        k = key.value
                        if k in ("query", "question", "prompt", "text", "user_input"):
                            best_idx = idx
                            break
                        val = node.value.values[idx]
                        if isinstance(val, ast.Constant) and val.value == "<value>":
                            best_idx = idx
                
                if best_idx == -1 and len(node.value.keys) > 0:
                    best_idx = 0  # Fallback to the first key

                if best_idx != -1:
                    # Replace the value with the actual query
                    node.value.values[best_idx] = ast.Constant(value=self.query)
                    self.replaced_inputs = True
                return node
                
        # Check if this is `session_id = ...`
        if self.session_id and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "session_id":
            # Just overwrite the assignment: session_id = "our_existing_id"
            self.bypassed_session_creation = True
            node.value = ast.Constant(value=self.session_id)
            return node

        return self.generic_visit(node)
        
    def visit_Call(self, node: ast.Call) -> ast.AST:
        # Check if we have an open(...) call inside a with block or standalone
        if isinstance(node.func, ast.Name) and node.func.id == "open":
            # Usually open("your_file.pdf", "rb")
            if len(node.args) >= 1 and isinstance(node.args[0], ast.Constant):
                # We could rewrite this if we know what file to map it to.
                # For now, if we have files mapped by expected file extension or just the first uploaded file.
                if self.files:
                    # Let's just grab the first uploaded file path if available
                    uploaded_path = list(self.files.values())[0]
                    node.args[0] = ast.Constant(value=uploaded_path)
        return self.generic_visit(node)

def rewrite_script(script_source: str, query: str, session_id: Optional[str] = None, files: Optional[Dict[str, str]] = None) -> str:
    """
    Parse the python script, transform it by injecting dynamic values, and unparse back to source string.
    """
    tree = ast.parse(script_source)
    rewriter = ScriptRewriter(query=query, session_id=session_id, files=files)
    new_tree = rewriter.visit(tree)
    ast.fix_missing_locations(new_tree)
    
    # Python 3.9+ supports ast.unparse
    new_source = ast.unparse(new_tree)
    
    # If the script didn't have a structured inputs dictionary, fallback to simple string replace just in case
    if not rewriter.replaced_inputs and '"<value>"' in new_source:
        new_source = new_source.replace('"<value>"', json.dumps(query))
        
    return new_source
