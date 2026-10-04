// Command tuning-values inspects Go constants for the cross-language test.
// It reads source and evaluates constant expressions; it never generates files.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/constant"
	"go/parser"
	"go/token"
	"go/types"
	"os"

	"baboreborn/backend/compatibility"
)

func values(path string) (map[string]any, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		return nil, err
	}
	if len(file.Imports) != 0 {
		return nil, fmt.Errorf("tuning must have no imports")
	}
	config := types.Config{}
	pkg, err := config.Check("tuning", fset, []*ast.File{file}, nil)
	if err != nil {
		return nil, err
	}
	result := make(map[string]any)
	for _, name := range pkg.Scope().Names() {
		c, ok := pkg.Scope().Lookup(name).(*types.Const)
		if !ok || !c.Exported() {
			return nil, fmt.Errorf("%s must be an exported constant", name)
		}
		v := c.Val()
		switch v.Kind() {
		case constant.Bool:
			result[name] = constant.BoolVal(v)
		case constant.Int, constant.Float:
			n, _ := constant.Float64Val(constant.ToFloat(v))
			result[name] = n
		default:
			return nil, fmt.Errorf("%s must be numeric or boolean", name)
		}
	}
	return result, nil
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: tuning-values path/to/rules.go")
		os.Exit(1)
	}
	result, err := values(os.Args[1])
	if os.Args[1] == "--runtime" {
		result, err = compatibility.TuningValues(), nil
	}
	if err == nil {
		err = json.NewEncoder(os.Stdout).Encode(result)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
