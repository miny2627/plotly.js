/**
* Copyright 2012-2020, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/


'use strict';

var parseSvgPath = require('parse-svg-path');

var dragElement = require('../../components/dragelement');
var dragHelpers = require('../../components/dragelement/helpers');
var drawMode = dragHelpers.drawMode;
var openMode = dragHelpers.openMode;

var Registry = require('../../registry');
var Lib = require('../../lib');
var setCursor = require('../../lib/setcursor');

var constants = require('./constants');
var MINSELECT = constants.MINSELECT;
var CIRCLE_SIDES = 32; // should be divisible by 8
var SQRT2 = Math.sqrt(2);

var helpers = require('./helpers');
var p2r = helpers.p2r;
var getTransform = helpers.getTransform;

var handleOutline = require('./handle_outline');
var clearOutlineControllers = handleOutline.clearOutlineControllers;
var clearSelect = handleOutline.clearSelect;

function recordPositions(polygonsOut, polygonsIn) {
    for(var i = 0; i < polygonsIn.length; i++) {
        polygonsOut[i] = [];
        var len = polygonsIn[i].length;
        for(var j = 0; j < len; j++) {
            // skip close points
            if(dist(polygonsIn[i][j], polygonsIn[i][(j + 1) % len]) < 1) continue;

            polygonsOut[i].push([
                polygonsIn[i][j][0],
                polygonsIn[i][j][1]
            ]);
        }
    }
    return polygonsOut;
}

function displayOutlines(polygonsIn, outlines, dragOptions, nCalls) {
    var polygons = recordPositions([], polygonsIn);

    if(!nCalls) nCalls = 0;

    var gd = dragOptions.gd;

    function redraw() {
        dragOptions.isActiveShape = false; // i.e. to disable controllers
        var shapes = addNewShapes(outlines, dragOptions);
        if(shapes) {
            delete gd._fullLayout._activeShapeIndex;

            Registry.call('_guiRelayout', gd, {
                shapes: shapes // update active shape
            });
        }

        if(nCalls !== -1) {
            // recursive call
            displayOutlines(polygons, outlines, dragOptions, nCalls++);
        }
    }

    var isActiveShape = dragOptions.isActiveShape;
    var plotinfo = dragOptions.plotinfo;
    var transform = isActiveShape ? '' : getTransform(plotinfo);
    var fullLayout = gd._fullLayout;
    var zoomLayer = fullLayout._zoomlayer;

    var dragmode = dragOptions.dragmode;
    var isDrawMode = drawMode(dragmode);
    var isOpenMode = openMode(dragmode);

    if(isDrawMode) gd._fullLayout._drawing = true;

    var paths = [];
    for(var k = 0; k < polygons.length; k++) {
        // create outline path
        paths.push(
            providePath(polygons[k], isOpenMode)
        );
    }

    // make outline
    outlines.attr('d', writePaths(paths, isOpenMode));

    // remove previous controllers
    clearOutlineControllers(gd);

    // add controllers
    var rVertexController = MINSELECT * 1.5; // bigger vertex buttons
    var vertexDragOptions;
    var indexI; // cell index
    var indexJ; // vertex or cell-controller index
    var copyPolygons;

    copyPolygons = recordPositions([], polygons);

    if(isActiveShape ||
        (isDrawMode && fullLayout.newshape.drawstep === 'gradual')
    ) {
        var g = zoomLayer.append('g').attr('class', 'outline-controllers');
        addVertexControllers(g);
    }

    function startDragVertex(evt) {
        indexI = +evt.srcElement.getAttribute('data-i');
        indexJ = +evt.srcElement.getAttribute('data-j');

        vertexDragOptions[indexI][indexJ].moveFn = moveVertexController;
    }

    function moveVertexController(dx, dy) {
        if(!polygons.length) return;

        var x0 = copyPolygons[indexI][indexJ][0];
        var y0 = copyPolygons[indexI][indexJ][1];

        var cell = polygons[indexI];
        var len = cell.length;
        if(pointsShapeRectangle(cell)) {
            for(var q = 0; q < len; q++) {
                if(q === indexJ) continue;

                // move other corners of rectangle
                var pos = cell[q];

                if(pos[0] === cell[indexJ][0]) {
                    pos[0] = x0 + dx;
                }

                if(pos[1] === cell[indexJ][1]) {
                    pos[1] = y0 + dy;
                }
            }
            // move the corner
            cell[indexJ][0] = x0 + dx;
            cell[indexJ][1] = y0 + dy;

            if(!pointsShapeRectangle(cell)) {
                // reject result to rectangles with ensure areas
                for(var j = 0; j < len; j++) {
                    for(var k = 0; k < 2; k++) {
                        cell[j][k] = copyPolygons[indexI][j][k];
                    }
                }
            }
        } else { // other polylines
            cell[indexJ][0] = x0 + dx;
            cell[indexJ][1] = y0 + dy;
        }

        redraw();
    }

    function endDragVertexController(evt) {
        Lib.noop(evt);
    }

    function removeVertex() {
        if(!polygons.length) return;

        var newPolygon = [];
        for(var j = 0; j < polygons[indexI].length; j++) {
            if(j !== indexJ) {
                newPolygon.push(
                    polygons[indexI][j]
                );
            }
        }
        polygons[indexI] = newPolygon;
    }

    function clickVertexController(numClicks) {
        if(numClicks === 2) {
            var cell = polygons[indexI];
            if(cell.length > 2 && !(pointsShapeRectangle(cell))) {
                removeVertex();
            }

            redraw();
        }
    }

    function addVertexControllers(g) {
        vertexDragOptions = [];

        for(var i = 0; i < polygons.length; i++) {
            var cell = polygons[i];

            if(dragmode === 'ellipsedraw' && pointsShapeEllipse(cell)) {
                return; // no need for vertex modifiers on ellipses
            }
            var onRect = (pointsShapeRectangle(cell));
            var minX;
            var minY;
            var maxX;
            var maxY;
            if(onRect) {
                // compute bounding box
                minX = calcMin(cell, 0);
                minY = calcMin(cell, 1);
                maxX = calcMax(cell, 0);
                maxY = calcMax(cell, 1);
            }

            vertexDragOptions[i] = [];
            for(var j = 0; j < cell.length; j++) {
                var x = cell[j][0];
                var y = cell[j][1];

                var rIcon = 3;
                var button = g.append(onRect ? 'rect' : 'circle')
                .attr('transform', transform)
                .style({
                    'mix-blend-mode': 'luminosity',
                    fill: 'black',
                    stroke: 'white',
                    'stroke-width': 1
                });

                if(onRect) {
                    button
                        .attr('x', x - rIcon)
                        .attr('y', y - rIcon)
                        .attr('width', 2 * rIcon)
                        .attr('height', 2 * rIcon);
                } else {
                    button
                        .attr('cx', x)
                        .attr('cy', y)
                        .attr('r', rIcon);
                }

                var vertex = g.append(onRect ? 'rect' : 'circle')
                .attr('data-i', i)
                .attr('data-j', j)
                .attr('transform', transform)
                .style({
                    opacity: 0
                });

                if(onRect) {
                    var ratioX = (x - minX) / (maxX - minX);
                    var ratioY = (y - minY) / (maxY - minY);
                    if(isFinite(ratioX) && isFinite(ratioY)) {
                        setCursor(
                            vertex,
                            dragElement.getCursor(ratioX, 1 - ratioY)
                        );
                    }

                    vertex
                        .attr('x', x - rVertexController)
                        .attr('y', y - rVertexController)
                        .attr('width', 2 * rVertexController)
                        .attr('height', 2 * rVertexController);
                } else {
                    vertex
                        .classed('cursor-grab', true)
                        .attr('cx', x)
                        .attr('cy', y)
                        .attr('r', rVertexController);
                }

                vertexDragOptions[i][j] = {
                    element: vertex.node(),
                    gd: gd,
                    prepFn: startDragVertex,
                    doneFn: endDragVertexController,
                    clickFn: clickVertexController
                };

                dragElement.init(vertexDragOptions[i][j]);
            }
        }
    }
}

function providePath(cell, isOpenMode) {
    return cell.join('L') + (
        isOpenMode ? '' : 'L' + cell[0]
    );
}

function writePaths(paths, isOpenMode) {
    return paths.length > 0 ? 'M' + paths.join('M') + (isOpenMode ? '' : 'Z') : 'M0,0Z';
}

function readPaths(str, plotinfo, size) {
    var cmd = parseSvgPath(str);

    var polys = [];
    var n = -1;
    var newPoly = function() {
        n++;
        polys[n] = [];
    };

    var x = 0;
    var y = 0;
    var initX;
    var initY;
    var recStart = function() {
        initX = x;
        initY = y;
    };

    recStart();
    for(var i = 0; i < cmd.length; i++) {
        var c = cmd[i][0];
        switch(c) {
            case 'M':
                newPoly();
                x = +cmd[i][1];
                y = +cmd[i][2];
                recStart();
                break;

            case 'm':
                newPoly();
                x += +cmd[i][1];
                y += +cmd[i][2];
                break;

            case 'L':
                x = +cmd[i][1];
                y = +cmd[i][2];
                break;

            case 'l':
                x += +cmd[i][1];
                y += +cmd[i][2];
                break;

            case 'H':
                x = +cmd[i][1];
                break;

            case 'h':
                x += +cmd[i][1];
                break;

            case 'V':
                y = +cmd[i][1];
                break;

            case 'v':
                y += +cmd[i][1];
                break;
        }

        if(c === 'Z') {
            x = initX;
            y = initY;
        } else {
            if(!plotinfo) {
                polys[n].push([
                    x,
                    y
                ]);
            } else if(plotinfo.domain) {
                polys[n].push([
                    plotinfo.domain.x[0] + x / size.w,
                    plotinfo.domain.y[1] - y / size.h
                ]);
            } else {
                polys[n].push([
                    p2r(plotinfo.xaxis, x),
                    p2r(plotinfo.yaxis, y)
                ]);
            }
        }
    }

    return polys;
}

function fixDatesOnPaths(path, xaxis, yaxis) {
    var xIsDate = xaxis.type === 'date';
    var yIsDate = yaxis.type === 'date';
    if(!xIsDate && !yIsDate) return path;

    for(var i = 0; i < path.length; i++) {
        if(xIsDate) path[i][0] = path[i][0].replace(' ', '_');
        if(yIsDate) path[i][1] = path[i][1].replace(' ', '_');
    }

    return path;
}

function almostEq(a, b) {
    return Math.abs(a - b) <= 1e-6;
}

function dist(a, b) {
    var dx = b[0] - a[0];
    var dy = b[1] - a[1];
    return Math.sqrt(
        dx * dx +
        dy * dy
    );
}

function calcMin(cell, dim) {
    var v = Infinity;
    for(var i = 0; i < cell.length; i++) {
        v = Math.min(v, cell[i][dim]);
    }
    return v;
}

function calcMax(cell, dim) {
    var v = -Infinity;
    for(var i = 0; i < cell.length; i++) {
        v = Math.max(v, cell[i][dim]);
    }
    return v;
}

function pointsShapeRectangle(cell, len) {
    if(!len) len = cell.length;
    if(len !== 4) return false;
    for(var j = 0; j < 2; j++) {
        var e01 = cell[0][j] - cell[1][j];
        var e32 = cell[3][j] - cell[2][j];

        if(!almostEq(e01, e32)) return false;

        var e03 = cell[0][j] - cell[3][j];
        var e12 = cell[1][j] - cell[2][j];
        if(!almostEq(e03, e12)) return false;
    }

    // N.B. rotated rectangles are not valid rects since rotation is not supported in shapes for now.
    if(
        !almostEq(cell[0][0], cell[1][0]) &&
        !almostEq(cell[0][0], cell[3][0])
    ) return false;

    // reject cases with zero area
    return !!(
        dist(cell[0], cell[1]) *
        dist(cell[0], cell[3])
    );
}

function pointsShapeEllipse(cell, len) {
    if(!len) len = cell.length;
    if(len !== CIRCLE_SIDES) return false;
    // opposite diagonals should be the same
    for(var i = 0; i < len; i++) {
        var k = (len * 2 - i) % len;

        var k2 = (len / 2 + k) % len;
        var i2 = (len / 2 + i) % len;

        if(!almostEq(
            dist(cell[i], cell[i2]),
            dist(cell[k], cell[k2])
        )) return false;
    }
    return true;
}

function handleEllipse(isEllipse, start, end) {
    if(!isEllipse) return [start, end]; // i.e. case of line

    var pos = ellipseOver({
        x0: start[0],
        y0: start[1],
        x1: end[0],
        y1: end[1]
    });

    var cx = (pos.x1 + pos.x0) / 2;
    var cy = (pos.y1 + pos.y0) / 2;
    var rx = (pos.x1 - pos.x0) / 2;
    var ry = (pos.y1 - pos.y0) / 2;

    // make a circle when one dimension is zero
    if(!rx) rx = ry = ry / SQRT2;
    if(!ry) ry = rx = rx / SQRT2;

    var cell = [];
    for(var i = 0; i < CIRCLE_SIDES; i++) {
        var t = i * 2 * Math.PI / CIRCLE_SIDES;
        cell.push([
            cx + rx * Math.cos(t),
            cy + ry * Math.sin(t),
        ]);
    }
    return cell;
}

function ellipseOver(pos) {
    var x0 = pos.x0;
    var y0 = pos.y0;
    var x1 = pos.x1;
    var y1 = pos.y1;

    var dx = x1 - x0;
    var dy = y1 - y0;

    x0 -= dx;
    y0 -= dy;

    var cx = (x0 + x1) / 2;
    var cy = (y0 + y1) / 2;

    var scale = SQRT2;
    dx *= scale;
    dy *= scale;

    return {
        x0: cx - dx,
        y0: cy - dy,
        x1: cx + dx,
        y1: cy + dy
    };
}

function addNewShapes(outlines, dragOptions) {
    if(!outlines.length) return;
    var e = outlines[0][0]; // pick first
    if(!e) return;
    var d = e.getAttribute('d');

    var gd = dragOptions.gd;
    var drwStyle = gd._fullLayout.newshape;

    var plotinfo = dragOptions.plotinfo;
    var xaxis = plotinfo.xaxis;
    var yaxis = plotinfo.yaxis;
    var onPaper = plotinfo.domain;

    var isActiveShape = dragOptions.isActiveShape;
    var dragmode = dragOptions.dragmode;
    if(isActiveShape) {
        var id = gd._fullLayout._activeShapeIndex;
        var s = id >= 0 ? gd._fullLayout.shapes[id] : {};

        switch(s.type) {
            case 'rect':
                dragmode = 'rectdraw';
                break;
            case 'circle':
                dragmode = 'ellipsedraw';
                break;
            case 'line':
                dragmode = 'linedraw';
                break;
            default:
                if(d[d.length - 1] === 'Z') {
                    dragmode = 'closedfreedraw';
                } else {
                    dragmode = 'openfreedraw';
                }
                break;
        }
    }
    var isOpenMode = openMode(dragmode);

    var newShapes = [];
    var fullLayout = gd._fullLayout;

    if(!isActiveShape) {
        // de-activate previous active shape
        delete fullLayout._activeShapeIndex;
    }

    var polygons = isActiveShape ? readPaths(d) : readPaths(d, plotinfo, fullLayout._size);
    for(var i = 0; i < polygons.length; i++) {
        var cell = polygons[i];
        var len = cell.length;
        if(
            cell[0][0] === cell[len - 1][0] &&
            cell[0][1] === cell[len - 1][1]
        ) {
            len -= 1;
        }
        if(len < 2) continue;

        var shape = {
            activable: true,

            xref: onPaper ? 'paper' : xaxis._id,
            yref: onPaper ? 'paper' : yaxis._id,

            layer: drwStyle.layer,
            opacity: drwStyle.opacity,
            line: {
                color: drwStyle.line.color,
                width: drwStyle.line.width,
                dash: drwStyle.line.dash
            }
        };

        if(!isOpenMode) {
            shape.fillcolor = drwStyle.fillcolor;
            shape.fillrule = drwStyle.fillrule;
        }

        if(
            dragmode === 'rectdraw' &&
            pointsShapeRectangle(cell, len) // should pass len here which is equal to cell.length - 1 i.e. because of the closing point
        ) {
            shape.type = 'rect';
            shape.x0 = cell[0][0];
            shape.y0 = cell[0][1];
            shape.x1 = cell[2][0];
            shape.y1 = cell[2][1];
        } else if(
            dragmode === 'linedraw'
        ) {
            shape.type = 'line';
            shape.x0 = cell[0][0];
            shape.y0 = cell[0][1];
            shape.x1 = cell[1][0];
            shape.y1 = cell[1][1];
        } else if(
            dragmode === 'ellipsedraw' &&
            pointsShapeEllipse(cell, len) && // should pass len here which is equal to cell.length - 1 i.e. because of the closing point
            xaxis.type !== 'log' && yaxis.type !== 'log' &&
            xaxis.type !== 'date' && yaxis.type !== 'date'
        ) {
            shape.type = 'circle'; // an ellipse!
            var j = Math.floor((CIRCLE_SIDES + 1) / 2);
            var k = Math.floor((CIRCLE_SIDES + 1) / 8);
            var pos = ellipseOver({
                x0: (cell[0][0] + cell[j][0]) / 2,
                y0: (cell[0][1] + cell[j][1]) / 2,
                x1: cell[k][0],
                y1: cell[k][1]
            });
            shape.x0 = pos.x0;
            shape.y0 = pos.y0;
            shape.x1 = pos.x1;
            shape.y1 = pos.y1;
        } else {
            shape.type = 'path';
            fixDatesOnPaths(cell, xaxis, yaxis);

            shape.path = writePaths([
                providePath(cell, isOpenMode)
            ], isOpenMode);
        }

        newShapes.push(shape);
    }

    // remove outline and controllers
    clearSelect(gd);

    var shapes;
    if(newShapes.length) {
        var updatedActiveShape = false;
        shapes = [];
        for(var q = 0; q < fullLayout.shapes.length; q++) {
            var beforeEdit = fullLayout.shapes[q];
            shapes[q] = beforeEdit._input;

            if(
                isActiveShape &&
                q === fullLayout._activeShapeIndex
            ) {
                var afterEdit = newShapes[0]; // pick first

                switch(afterEdit.type) {
                    case 'line':
                    case 'rect':
                    case 'circle':
                        updatedActiveShape = hasChanged(beforeEdit, afterEdit, ['x0', 'x1', 'y0', 'y1']);
                        if(updatedActiveShape) { // update active shape
                            shapes[q].x0 = afterEdit.x0;
                            shapes[q].x1 = afterEdit.x1;
                            shapes[q].y0 = afterEdit.y0;
                            shapes[q].y1 = afterEdit.y1;
                        }
                        break;

                    case 'path':
                        updatedActiveShape = hasChanged(beforeEdit, afterEdit, ['path']);
                        if(updatedActiveShape) { // update active shape
                            shapes[q].path = afterEdit.path;
                        }
                        break;
                }
            }
        }

        if(!isActiveShape) {
            shapes = shapes.concat(newShapes); // add new shapes
        }
    }

    return shapes;
}

function hasChanged(beforeEdit, afterEdit, keys) {
    for(var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if(beforeEdit[k] !== afterEdit[k]) {
            return true;
        }
    }
    return false;
}

module.exports = {
    displayOutlines: displayOutlines,
    handleEllipse: handleEllipse,
    addNewShapes: addNewShapes,
    readPaths: readPaths
};
